// Draws everyone's lasers over the whole shared display. Positions arrive
// normalized to the shared screen (0–1), which is exactly this window.
import { LaserBoard, LaserView } from './vendor/laser.js';

const canvas = document.querySelector('#laser');
const board = new LaserBoard();
const looks = new Map();
board.look = (id) => looks.get(id) || { style: 'red', label: '' };
// The whole window is the screen: no letterboxing to account for.
const frame = { get videoWidth() { return innerWidth; }, get videoHeight() { return innerHeight; } };
// A little larger than in the app, so it reads at screen scale.
const view = new LaserView(canvas, frame, board, 1.25);

window.overlay.onEvent((message) => {
  if (message.type === 'apply') {
    looks.set(message.id, message.look);
    board.apply(message.id, message.point);
  } else if (message.type === 'clear') {
    if (message.id) {
      board.clear(message.id);
      looks.delete(message.id);
    } else {
      board.clear();
      looks.clear();
    }
  } else if (message.type === 'reset') {
    board.clear();
    looks.clear();
  }
  view.wake();
});
addEventListener('resize', () => view.wake());
