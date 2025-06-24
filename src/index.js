const { generateUsername } = require('unique-username-generator');
const { Buffer } = require('buffer');

function handle(request) {
  const name = generateUsername('-', 3, 0); // e.g. "sunny-mountain-472"
  const buf = Buffer.from(`Your unique name: ${name}`);
  return new Response(buf.toString(), {
    headers: { 'content-type': 'text/plain' }
  });
}

module.exports = { fetch: handle };
