'use strict';

// All dimensions are CSS pixels / Electron device-independent pixels.
function petLayout(scale = 1, area = { width: 1920, height: 1080 }) {
  const requestedScale = Math.max(0.5, Math.min(2, Number.isFinite(scale) ? scale : 1));
  const availableWidth = Math.max(1, Math.floor(area.width));
  const availableHeight = Math.max(1, Math.floor(area.height));
  const bubbleHeight = Math.min(110, Math.max(40, availableHeight * 0.25));
  const effectiveScale = Math.max(0.01, Math.min(requestedScale, (availableWidth - 45) / 315, (availableHeight - bubbleHeight - 23) / 367));
  const width = Math.min(availableWidth, Math.max(Math.min(320, availableWidth), Math.ceil(315 * effectiveScale + 45)));
  const canvasHeight = Math.min(availableHeight - bubbleHeight, Math.ceil(367 * effectiveScale + 23));
  const height = Math.min(availableHeight, Math.ceil(canvasHeight + bubbleHeight));
  return { width, height, canvasWidth: width, canvasHeight, bubbleHeight, requestedScale, effectiveScale,
    modelBoxWidth: 315 * effectiveScale, modelBoxHeight: 367 * effectiveScale, footY: canvasHeight - 6 };
}

function clampBounds(bounds, area) {
  const width = Math.min(Math.max(1, Math.round(bounds.width)), area.width);
  const height = Math.min(Math.max(1, Math.round(bounds.height)), area.height);
  return { x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, bounds.x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, bounds.y))), width, height };
}

function resizeAtFeet(previous, layout, area) {
  const centerX = previous.x + previous.width / 2;
  const bottom = previous.y + previous.height;
  return clampBounds({ x: centerX - layout.width / 2, y: bottom - layout.height, width: layout.width, height: layout.height }, area);
}

module.exports = { petLayout, clampBounds, resizeAtFeet };
