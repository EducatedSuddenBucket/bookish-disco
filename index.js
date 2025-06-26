import { AutoRouter } from 'itty-router'
import { connect } from 'net'

const router = AutoRouter()

// Utility functions for Minecraft protocol
function createVarInt(value) {
  const bytes = []
  while (true) {
    if ((value & 0xffffff80) === 0) {
      bytes.push(value)
      return new Uint8Array(bytes)
    }
    bytes.push(value & 0x7f | 0x80)
    value >>>= 7
  }
}

function createPacket(id, data) {
  const idBuffer = createVarInt(id)
  const lengthBuffer = createVarInt(idBuffer.length + data.length)
  return new Uint8Array([...lengthBuffer, ...idBuffer, ...data])
}

function readVarInt(buffer, offset) {
  let value = 0
  let size = 0
  let byte
  do {
    byte = buffer[offset++]
    value |= (byte & 0x7f) << (size++ * 7)
    if (size > 5) {
      throw new Error('VarInt is too big')
    }
  } while (byte & 0x80)
  return [value, offset]
}

function connectToJavaServer(host, port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    let buffer = new Uint8Array(0)
    let serverInfo
    let pingStartTime
    let hasResolvedOrRejected = false

    // Set a timeout for the entire operation
    const overallTimeout = setTimeout(() => {
      if (!hasResolvedOrRejected) {
        hasResolvedOrRejected = true
        socket.end()
        const error = new Error('timeout')
        error.code = 'TIMEOUT'
        reject(error)
      }
    }, 7000) // 7 seconds

    socket.setTimeout(7000) // Set socket timeout

    socket.on('connect', () => {
      const hostBuffer = new TextEncoder().encode(host)
      const portBuffer = new Uint8Array(2)
      new DataView(portBuffer.buffer).setUint16(0, port, false) // big endian
      
      const handshakeData = new Uint8Array([
        ...createVarInt(-1),
        ...createVarInt(hostBuffer.length),
        ...hostBuffer,
        ...portBuffer,
        ...createVarInt(1)
      ])
      
      const handshakePacket = createPacket(0x00, handshakeData)
      socket.write(handshakePacket)
      
      const statusRequestPacket = createPacket(0x00, new Uint8Array(0))
      socket.write(statusRequestPacket)
    })

    socket.on('data', (data) => {
      const newBuffer = new Uint8Array(buffer.length + data.length)
      newBuffer.set(buffer)
      newBuffer.set(data, buffer.length)
      buffer = newBuffer

      try {
        let offset = 0
        let [length, newOffset] = readVarInt(buffer, offset)
        offset = newOffset
        
        if (buffer.length >= offset + length) {
          let [packetId, newOffset] = readVarInt(buffer, offset)
          offset = newOffset
          
          if (packetId === 0x00) {
            let [jsonLength, newOffset] = readVarInt(buffer, offset)
            offset = newOffset
            const jsonResponse = new TextDecoder().decode(buffer.slice(offset, offset + jsonLength))
            serverInfo = JSON.parse(jsonResponse)
            
            const pingPacket = createPacket(0x01, new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]))
            pingStartTime = performance.now()
            socket.write(pingPacket)
            
            buffer = buffer.slice(offset + jsonLength)
          } else if (packetId === 0x01) {
            const latency = performance.now() - pingStartTime
            serverInfo.latency = Math.round(latency)
            
            if (!hasResolvedOrRejected) {
              hasResolvedOrRejected = true
              clearTimeout(overallTimeout)
              socket.end()
              resolve(serverInfo)
            }
          }
        }
      } catch (e) {
        if (!hasResolvedOrRejected) {
          hasResolvedOrRejected = true
          clearTimeout(overallTimeout)
          socket.end()
          reject(e)
        }
      }
    })

    socket.on('error', (err) => {
      if (!hasResolvedOrRejected) {
        hasResolvedOrRejected = true
        clearTimeout(overallTimeout)
        socket.end()
        reject(err)
      }
    })

    socket.on('timeout', () => {
      if (!hasResolvedOrRejected) {
        hasResolvedOrRejected = true
        clearTimeout(overallTimeout)
        socket.end()
        const error = new Error('timeout')
        error.code = 'TIMEOUT'
        reject(error)
      }
    })

    socket.on('close', () => {
      console.log('Connection closed')
    })
  })
}

function extractText(obj) {
  let text = ''
  
  // Handle plain string
  if (typeof obj === 'string') {
    return obj
  }
  
  // Handle color and formatting codes
  if (obj.color) {
    text += `§${getColorCode(obj.color)}`
  }
  if (obj.bold) {
    text += '§l'
  }
  if (obj.italic) {
    text += '§o'
  }
  if (obj.underlined) {
    text += '§n'
  }
  if (obj.strikethrough) {
    text += '§m'
  }
  if (obj.obfuscated) {
    text += '§k'
  }
  
  // Add text content
  if (obj.text) {
    text += obj.text
  }
  
  // Process extra array with proper reset codes
  if (obj.extra) {
    for (let i = 0; i < obj.extra.length; i++) {
      const item = obj.extra[i]
      const hasFormatting = item.color || item.bold || item.italic || 
                          item.underline || item.strikethrough || item.obfuscated
      
      // Add reset code between elements in the extra array if needed
      if (i > 0) {
        const prevItem = obj.extra[i - 1]
        const prevHasFormatting = prevItem.color || prevItem.bold || prevItem.italic || 
                               prevItem.underline || prevItem.strikethrough || prevItem.obfuscated
        
        if (prevHasFormatting) {
          text += '§r'
        }
      }
      
      // Process the item recursively
      text += extractText(item)
    }
  }
  
  return text
}

function removeColorCodes(text) {
  // Remove all Minecraft formatting codes (§ followed by any character)
  return text.replace(/§[0-9a-fklmnor]/gi, '')
}

function getColorCode(colorName) {
  const colorCodes = {
    black: '0',
    dark_blue: '1',
    dark_green: '2',
    dark_aqua: '3',
    dark_red: '4',
    dark_purple: '5',
    gold: '6',
    gray: '7',
    dark_gray: '8',
    blue: '9',
    green: 'a',
    aqua: 'b',
    red: 'c',
    light_purple: 'd',
    yellow: 'e',
    white: 'f'
  }
  return colorCodes[colorName] || 'f'
}

router.get('/', () => 'Test!')

router.get('/api/status/:serverAddress', async (request) => {
  const { serverAddress } = request.params
  const [serverHost, serverPort] = serverAddress.split(':')
  const port = serverPort ? parseInt(serverPort, 10) : 25565

  try {
    const response = await connectToJavaServer(serverHost, port)
    let description = ''
    
    if (typeof response.description === 'string') {
      description = response.description
    } else if (response.description) {
      description = extractText(response.description)
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
    }

    return Response.json(serverInfo)
  } catch (err) {
    console.error(err)
    let errorResponse = {
      success: false,
      error: {
        code: 'unknown_error',
        message: 'Failed to connect to the server'
      }
    }

    if (err.code === 'TIMEOUT') {
      errorResponse.error = {
        code: 'timeout',
        message: 'Connection to server timed out'
      }
    } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
      errorResponse.error = {
        code: 'invalid_domain',
        message: 'The domain name could not be resolved'
      }
    } else if (err.code === 'ECONNREFUSED') {
      errorResponse.error = {
        code: 'connection_refused',
        message: 'Server refused the connection'
      }
    } else {
      errorResponse.error = {
        code: 'offline',
        message: 'Server appears to be offline or unreachable'
      }
    }

    return Response.json(errorResponse)
  }
})

export default router
