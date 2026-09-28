// TEST BUILD ONLY. No privileged call, no nonce, no approval bypass.
await new Promise(resolve => setTimeout(resolve, 400));
document.getElementById("apply").click(); // isTrusted=false: MUST do nothing.
const point = id => {
  const r = document.getElementById(id).getBoundingClientRect();
  return { x: Math.round(window.mozInnerScreenX + r.x + r.width / 2), y: Math.round(window.mozInnerScreenY + r.y + r.height / 2) };
};
const a = point("apply"), d = point("deny");
console.log(`DRAFTSAFE_SMOKE_READY:${a.x},${a.y},${d.x},${d.y}`);
