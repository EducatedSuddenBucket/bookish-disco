import { AutoRouter } from 'itty-router'

const router = AutoRouter()

// Utility functions for Minecraft protocol
function createVarInt(value) {
  const bytes = [];
  while (true) {
    if ((value & 0xffffff80) === 0) {
      bytes.push(value);
      return new Uint8Array(bytes);
    }
    bytes.push(value & 0x7f | 0x80);
    value >>>= 7;
  }
}

function createPacket(id, data) {
  const idBuffer = createVarInt(id);
  const lengthBuffer = createVarInt(idBuffer.length + data.length);
  const result = new Uint8Array(lengthBuffer.length + idBuffer.length + data.length);
  result.set(lengthBuffer, 0);
  result.set(idBuffer, lengthBuffer.length);
  result.set(data, lengthBuffer.length + idBuffer.length);
  return result;
}

function readVarInt(buffer, offset) {
  let value = 0;
  let size = 0;
  let byte;
  do {
    byte = buffer[offset++];
    value |= (byte & 0x7f) << (size++ * 7);
    if (size > 5) {
      throw new Error('VarInt is too big');
    }
  } while (byte & 0x80);
  return [value, offset];
}

function extractText(obj) {
  let text = '';
  
  if (typeof obj === 'string') {
    return obj;
  }
  
  if (obj.color) {
    text += `§${getColorCode(obj.color)}`;
  }
  if (obj.bold) text += '§l';
  if (obj.italic) text += '§o';
  if (obj.underlined) text += '§n';
  if (obj.strikethrough) text += '§m';
  if (obj.obfuscated) text += '§k';
  
  if (obj.text) {
    text += obj.text;
  }
  
  if (obj.extra) {
    for (let i = 0; i < obj.extra.length; i++) {
      const item = obj.extra[i];
      
      if (i > 0) {
        const prevItem = obj.extra[i - 1];
        const prevHasFormatting = prevItem.color || prevItem.bold || prevItem.italic || 
                               prevItem.underline || prevItem.strikethrough || prevItem.obfuscated;
        
        if (prevHasFormatting) {
          text += '§r';
        }
      }
      
      text += extractText(item);
    }
  }
  
  return text;
}

function removeColorCodes(text) {
  return text.replace(/§[0-9a-fklmnor]/gi, '');
}

function getColorCode(colorName) {
  const colorCodes = {
    black: '0', dark_blue: '1', dark_green: '2', dark_aqua: '3',
    dark_red: '4', dark_purple: '5', gold: '6', gray: '7',
    dark_gray: '8', blue: '9', green: 'a', aqua: 'b',
    red: 'c', light_purple: 'd', yellow: 'e', white: 'f'
  };
  return colorCodes[colorName] || 'f';
}

async function connectToJavaServer(host, port) {
  try {
    // Connect using Cloudflare's connect() API
    const socket = connect({
      hostname: host,
      port: port
    });

    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    // Create handshake packet
    const hostBuffer = new TextEncoder().encode(host);
    const portBuffer = new Uint8Array(2);
    new DataView(portBuffer.buffer).setUint16(0, port, false);
    
    const handshakeData = new Uint8Array(
      createVarInt(-1).length + 
      createVarInt(hostBuffer.length).length + 
      hostBuffer.length + 
      portBuffer.length + 
      createVarInt(1).length
    );
    
    let offset = 0;
    const varIntNeg1 = createVarInt(-1);
    handshakeData.set(varIntNeg1, offset);
    offset += varIntNeg1.length;
    
    const varIntHostLen = createVarInt(hostBuffer.length);
    handshakeData.set(varIntHostLen, offset);
    offset += varIntHostLen.length;
    
    handshakeData.set(hostBuffer, offset);
    offset += hostBuffer.length;
    
    handshakeData.set(portBuffer, offset);
    offset += portBuffer.length;
    
    const varInt1 = createVarInt(1);
    handshakeData.set(varInt1, offset);

    const handshakePacket = createPacket(0x00, handshakeData);
    await writer.write(handshakePacket);

    // Send status request
    const statusRequestPacket = createPacket(0x00, new Uint8Array(0));
    await writer.write(statusRequestPacket);

    // Read response with timeout
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('timeout')), 7000)
    );

    let buffer = new Uint8Array(0);
    let serverInfo;
    let pingStartTime;

    const readResponse = async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        // Concatenate buffers
        const newBuffer = new Uint8Array(buffer.length + value.length);
        newBuffer.set(buffer);
        newBuffer.set(value, buffer.length);
        buffer = newBuffer;

        // Try to parse packets
        let offset = 0;
        while (offset < buffer.length) {
          try {
            const [length, newOffset] = readVarInt(buffer, offset);
            if (buffer.length < newOffset + length) break;

            const [packetId, dataOffset] = readVarInt(buffer, newOffset);
            
            if (packetId === 0x00) {
              const [jsonLength, jsonOffset] = readVarInt(buffer, dataOffset);
              const jsonData = buffer.slice(jsonOffset, jsonOffset + jsonLength);
              const jsonResponse = new TextDecoder().decode(jsonData);
              serverInfo = JSON.parse(jsonResponse);
              
              // Send ping packet
              const pingData = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
              const pingPacket = createPacket(0x01, pingData);
              pingStartTime = Date.now();
              await writer.write(pingPacket);
              
              offset = newOffset + length;
            } else if (packetId === 0x01) {
              const latency = Date.now() - pingStartTime;
              serverInfo.latency = Math.round(latency);
              await writer.close();
              return serverInfo;
            } else {
              offset = newOffset + length;
            }
          } catch (e) {
            break;
          }
        }
        
        // Remove processed data
        buffer = buffer.slice(offset);
      }
    };

    return await Promise.race([readResponse(), timeoutPromise]);

  } catch (error) {
    throw error;
  }
}

// Routes
router.get('/', () => 'Minecraft Server Status API')

router.get('/api/status/:serverAddress', async (request) => {
  const { serverAddress } = request.params;
  const [serverHost, serverPortStr] = serverAddress.split(':');
  const port = serverPortStr ? parseInt(serverPortStr, 10) : 25565;

  try {
    const response = await connectToJavaServer(serverHost, port);
    
    let description = '';
    if (typeof response.description === 'string') {
      description = response.description;
    } else if (response.description) {
      description = extractText(response.description);
    }

    const serverInfo = {
      success: true,
      version: response.version,
      players: {
        max: response.players.max,
        online: response.players.online,
        list: response.players.sample || []
      },
      description: description,
      description_clean: removeColorCodes(description),
      latency: response.latency,
      favicon: response.favicon
    };

    return Response.json(serverInfo);
  } catch (err) {
    console.error('Ping failed:', err);
    
    let errorResponse = {
      success: false,
      error: {
        code: 'unknown_error',
        message: 'Failed to connect to the server'
      }
    };

    if (err.message === 'timeout') {
      errorResponse.error = {
        code: 'timeout',
        message: 'Connection to server timed out'
      };
    } else if (err.message.includes('getaddrinfo ENOTFOUND') || err.message.includes('ENOTFOUND')) {
      errorResponse.error = {
        code: 'invalid_domain',
        message: 'The domain name could not be resolved'
      };
    } else if (err.message.includes('ECONNREFUSED')) {
      errorResponse.error = {
        code: 'connection_refused',
        message: 'Server refused the connection'
      };
    } else {
      errorResponse.error = {
        code: 'offline',
        message: 'Server appears to be offline or unreachable'
      };
    }

    return Response.json(errorResponse, { status: 500 });
  }
});

// CORS headers for all routes
router.all('*', (request) => {
  return new Response('Not Found', { 
    status: 404,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
});

export default router
