// Shown when screenpeek.me can't be reached. Retries on its own every ten seconds.
const retry = () => window.screenpeekDesktop?.retry();
document.querySelector('#retry').addEventListener('click', retry);
let seconds = 10;
setInterval(() => {
  seconds--;
  if (seconds <= 0) {
    seconds = 10;
    retry();
  }
  document.querySelector('#next').textContent = `Trying again in ${seconds}s`;
}, 1000);
