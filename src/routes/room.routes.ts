import { createRoom, deleteRoom, editRoom, getRoom, getRooms, joinRoom, leaveRoom, removeParticipant } from "../controllers/room.controller"
import { getRoomMessages } from "../controllers/message.controller"
import { checkStatus } from "../middlewares/checkStatus.middleware"

const router =  require('express').Router()

router.post('/', checkStatus(['admin','root','user']), createRoom)
router.get('/', checkStatus(['admin','root','user']), getRooms)
router.get('/:id', checkStatus(['admin','root','user']), getRoom)
router.get('/:id/messages', checkStatus(['admin','root','user']), getRoomMessages)
router.patch('/:id', checkStatus(['admin','root','user']), editRoom)
router.delete('/:id', checkStatus(['admin','root','user']), deleteRoom)
router.post('/join/:id', checkStatus(['admin','root','user']), joinRoom)
router.post('/leave/:id', checkStatus(['admin','root','user']), leaveRoom)
router.post('/:id/remove', checkStatus(['admin','root','user']), removeParticipant)

export default router