// Socket.io installs the real publisher at startup. Keeping it here avoids
// coupling HTTP controllers to the Express app module.
export let emitSeatChange = () => {};

export function setSeatChangeEmitter(publishSeatChange) {
  emitSeatChange = publishSeatChange;
}
