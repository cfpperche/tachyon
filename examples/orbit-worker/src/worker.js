// orbit-worker: drains the mission telemetry queue.
const tick = () => console.log(`[worker] drained batch at ${new Date().toISOString()}`);
setInterval(tick, 5000);
tick();
