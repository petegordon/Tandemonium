// Proposal (#428): the stoker's join screen with an on-screen keyboard. The 32
// room-code characters (lobby.js _spinnerChars, no I/O/0/1) fit an 8×4 grid
// exactly, so any letter is a few d-pad moves away instead of up to 16 spinner
// steps. Shown mid-entry ("K9" typed, focus on N). Mock-only DOM (class mock-dom).
const step = document.getElementById('lobby-join');
if (step) {
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const typed = ['K', '9'];
  const focus = 'N';
  const keys = [...CHARS].map((c) => `<span class="mj-key${c === focus ? ' focus' : ''}">${c}</span>`).join('');
  const slots = [0, 1, 2, 3].map((i) => `<span class="mj-slot${i === typed.length ? ' cur' : ''}${typed[i] ? ' set' : ''}">${typed[i] || ''}</span>`).join('');
  const box = document.createElement('div');
  box.className = 'mock-dom';
  box.id = 'mock-join';
  box.innerHTML = `
    <h2>Join a ride</h2>
    <p class="mj-sub">Enter the code on the captain’s screen.</p>
    <div class="mj-code"><span class="mj-prefix">TNDM–</span>${slots}</div>
    <div class="mj-grid">${keys}</div>
    <div class="mj-actions"><span class="mj-btn">⌫ Delete</span><span class="mj-btn accent disabled">JOIN</span></div>
    <p class="mj-hints"><span><i>✕</i> Type</span><span><i>□</i> Delete</span><span><i>◯</i> Back</span><span>A keyboard works too</span></p>`;
  step.appendChild(box);
}
