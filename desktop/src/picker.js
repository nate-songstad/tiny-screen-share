// The desktop app's screen picker. Knowing which display was chosen is what lets
// the laser appear on the right screen.
const $ = (selector) => document.querySelector(selector);
let sources = [];
let kind = 'screen';
let selected = null;

function tile(source) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tile';
  button.setAttribute('role', 'option');
  button.dataset.id = source.id;
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (source.thumbnail) thumb.style.backgroundImage = `url("${source.thumbnail}")`;
  else thumb.textContent = source.kind === 'screen' ? 'Screen' : 'Window';
  const label = document.createElement('div');
  label.className = 'label';
  if (source.icon) {
    const icon = document.createElement('img');
    icon.src = source.icon;
    icon.alt = '';
    label.append(icon);
  }
  const name = document.createElement('span');
  name.textContent = source.name;
  label.append(name);
  if (source.primary) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'Main';
    label.append(tag);
  }
  button.append(thumb, label);
  button.addEventListener('click', () => select(source.id));
  button.addEventListener('dblclick', () => { select(source.id); share(); });
  return button;
}

function render() {
  const shown = sources.filter((source) => source.kind === kind);
  $('#screensTab').setAttribute('aria-selected', String(kind === 'screen'));
  $('#windowsTab').setAttribute('aria-selected', String(kind === 'window'));
  $('#screensTab').textContent = `Entire screen (${sources.filter((source) => source.kind === 'screen').length})`;
  $('#windowsTab').textContent = `Window (${sources.filter((source) => source.kind === 'window').length})`;
  $('#tip').classList.toggle('hidden', false);
  $('#tipText').textContent = kind === 'screen'
    ? 'Share an entire screen and everyone’s lasers appear right on it, over every app. Only you see them there.'
    : 'Sharing one window? Lasers show in Screenpeek’s preview instead of on screen, because windows can move.';
  const grid = $('#grid');
  grid.replaceChildren(...shown.map(tile));
  if (!shown.length) {
    const empty = document.createElement('p');
    empty.className = 'empty muted';
    empty.textContent = kind === 'screen' ? 'No screens found.' : 'No windows to share. Open the app you want to show, then try again.';
    grid.append(empty);
  }
  for (const button of grid.querySelectorAll('.tile')) button.setAttribute('aria-pressed', String(button.dataset.id === selected));
  $('#share').disabled = !shown.some((source) => source.id === selected);
}

function select(id) {
  selected = id;
  render();
  grid().querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus();
}
const grid = () => $('#grid');
function share() {
  if (!$('#share').disabled) window.picker.choose(selected);
}
function setKind(next) {
  kind = next;
  const first = sources.find((source) => source.kind === kind && (kind === 'window' || source.primary)) || sources.find((source) => source.kind === kind);
  selected = first?.id || null;
  render();
}

$('#screensTab').addEventListener('click', () => setKind('screen'));
$('#windowsTab').addEventListener('click', () => setKind('window'));
$('#share').addEventListener('click', share);
$('#cancel').addEventListener('click', () => window.picker.choose(null));
$('#settings').addEventListener('click', () => window.picker.openSettings());
$('#relaunch').addEventListener('click', () => window.picker.relaunch());
$('#setupLink').addEventListener('click', () => window.picker.setup());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.picker.choose(null);
  else if (event.key === 'Enter' && !$('#pick').classList.contains('hidden') && !event.target.closest('[role="tab"]')) share();
  else if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key) && selected) {
    const shown = sources.filter((source) => source.kind === kind);
    const index = shown.findIndex((source) => source.id === selected);
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next = shown[(index + step + shown.length) % shown.length];
    if (next) {
      event.preventDefault();
      select(next.id);
    }
  }
});

window.picker.state().then((state) => {
  if (!state) return;
  if (state.mode === 'permission') {
    $('#permission').classList.remove('hidden');
    $('#settings').classList.remove('hidden');
    $('#relaunch').classList.remove('hidden');
    $('#setupLink').classList.remove('hidden');
    $('#restricted').classList.toggle('hidden', state.access !== 'restricted');
    $('#settings').focus();
    return;
  }
  sources = state.sources;
  $('#pick').classList.remove('hidden');
  $('#share').classList.remove('hidden');
  setKind('screen');
  grid().querySelector('[aria-pressed="true"]')?.focus();
});
