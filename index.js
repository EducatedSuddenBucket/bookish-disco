import { AutoRouter } from 'itty-router'
import * as mc from 'minecraft-protocol'

const router = AutoRouter()

router.get('/', async () => {
  try {
    // Ping Hypixel server
    const response = await mc.ping({
      host: 'mc.hypixel.net',
      port: 25565,
      timeout: 10000 // 10 second timeout
    })

    // Return raw JSON response
    return new Response(JSON.stringify(response, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60' // Cache for 1 minute
      }
    })
  } catch (error) {
    // Return error as JSON
    return new Response(JSON.stringify({
      error: 'Failed to ping Hypixel server',
      message: error.message,
      timestamp: new Date().toISOString()
    }, null, 2), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    })
  }
})

// Health check endpoint
router.get('/health', () => {
  return new Response(JSON.stringify({
    status: 'healthy',
    timestamp: new Date().toISOString()
  }), {
    headers: {
      'Content-Type': 'application/json'
    }
  })
})

export default router
