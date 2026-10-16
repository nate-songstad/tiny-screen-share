// First-launch walkthrough: welcome → (move to Applications) → screen recording → done.
const $ = (selector) => document.querySelector(selector);
let flow = { steps: ['welcome', 'screen', 'done'], start: 'welcome' };
let step = 'welcome';
let access = 'not-determined';
// Turned on during this run: macOS needs a relaunch before capture works.
let grantedNow = false;
let poll = null;

function show(next) {
  step = next;
  clearInterval(poll);
  for (const section of document.querySelectorAll('[data-step]')) section.classList.toggle('hidden', section.dataset.step !== step);
  $('#progress').replaceChildren(...flow.steps.map((name) => {
    const dot = document.createElement('span');
    if (flow.steps.indexOf(name) <= flow.steps.indexOf(step)) dot.className = 'on';
    return dot;
  }));
  const numbered = flow.steps.filter((name) => name === 'move' || name === 'screen');
  if (numbered.includes('screen')) $('#screenEyebrow').textContent = `Step ${numbered.indexOf('screen') + 1}`;
  if (step === 'screen') {
    poll = setInterval(checkAccess, 1500);
    checkAccess();
  }
  buttons();
}

function next() {
  const index = flow.steps.indexOf(step);
  show(flow.steps[Math.min(index + 1, flow.steps.length - 1)]);
}

async function checkAccess() {
  const value = await window.setup.access();
  if (!value) return;
  if (value === 'granted' && access !== 'granted') grantedNow = true;
  access = value;
  if (step === 'screen') buttons();
}

function buttons() {
  const primary = $('#primary'), secondary = $('#secondary'), skip = $('#skip');
  secondary.classList.add('hidden');
  skip.classList.toggle('hidden', step === 'done' || step === 'welcome');
  skip.textContent = step === 'screen' ? 'Skip — I’ll only watch for now' : 'Not now';
  if (step === 'welcome') primary.textContent = 'Get started';
  else if (step === 'move') primary.textContent = 'Move to Applications';
  else if (step === 'done') primary.textContent = 'Start Screenpeek';
  else if (step === 'screen') {
    const badge = $('#accessBadge');
    badge.classList.toggle('ok', access === 'granted');
    badge.textContent = access === 'granted' ? (grantedNow ? 'Screen recording is on. Relaunch to finish.' : 'Screen recording is on')
      : access === 'restricted' ? 'Blocked by a profile on this Mac' : 'Screen recording is off';
    $('#screenSteps').classList.toggle('hidden', access === 'granted' && !grantedNow);
    if (access === 'granted') {
      primary.textContent = grantedNow ? 'Relaunch Screenpeek' : 'Continue';
      skip.classList.add('hidden');
    } else {
      primary.textContent = 'Open System Settings';
    }
  }
  primary.focus();
}

$('#primary').addEventListener('click', async () => {
  if (step === 'welcome') next();
  else if (step === 'move') {
    const moved = await window.setup.move();
    // On success the app relaunches from Applications; we only get here if it didn't.
    if (!moved) $('#moveFailed').classList.remove('hidden');
  } else if (step === 'screen') {
    if (access === 'granted' && grantedNow) window.setup.relaunch();
    else if (access === 'granted') next();
    else window.setup.register();
  } else if (step === 'done') window.setup.finish();
});
$('#skip').addEventListener('click', () => (step === 'screen' ? show('done') : next()));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.setup.finish(); });

window.setup.state().then((state) => {
  if (!state) return;
  flow = state;
  access = state.access;
  show(state.start);
});
