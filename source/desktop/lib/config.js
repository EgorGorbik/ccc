'use strict';
// Falcon Time desktop agent — configuration.
// Nothing here is hidden: the interval, the thumbnail size and the JPEG quality
// are exactly what the agent uses, and the cabinet is the only place frames go.
module.exports = {
  DEFAULT_CABINET: process.env.FALCON_CABINET || 'http://127.0.0.1:5173',
  INTERVAL_MS: 180000, // one frame every 3 minutes
  THUMB: {width: 1280, height: 720},
  JPEG_QUALITY: 60,
  MAX_QUEUE: 480, // ~24h of unsent frames; older ones are dropped, never batched up
  PERMISSION_POLL_MS: 8000,
  PARTITION: 'persist:falcon-time',
};
