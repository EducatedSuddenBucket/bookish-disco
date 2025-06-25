import { AutoRouter } from 'itty-router'

const router = AutoRouter()

router.get('/', () => 'Success!')

export default router // see note below
