(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetSpeech = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PASSIVE = new Set(['bot', 'chatter', 'sleepy']);
  const IDLE = new Set(['chatter', 'sleepy']);
  function speechAllowed(policy = {}, source = 'bot', now = Date.now()) {
    return !PASSIVE.has(source) || (!policy.quietMode && !(Number.isFinite(policy.muteUntil) && policy.muteUntil > now));
  }
  function priority(source) { return source === 'chat' ? 3 : PASSIVE.has(source) ? (IDLE.has(source) ? 0 : 1) : 2; }

  class SpeechQueue {
    constructor({ now = Date.now, onChange = () => {}, maxPending = 30 } = {}) {
      this.now = now; this.onChange = onChange; this.maxPending = Math.max(1, maxPending);
      this.pending = []; this.current = null; this.policy = {}; this.pausedAt = null; this.hovered = false;
    }
    snapshot() { return { current: this.current && { ...this.current }, pending: this.pending.length, paused: this.pausedAt !== null }; }
    changed() { this.onChange(this.snapshot()); }
    setPolicy(policy) {
      this.policy = { quietMode: policy.quietMode === true, muteUntil: Number.isFinite(policy.muteUntil) ? policy.muteUntil : 0 };
      this.pending = this.pending.filter(item => speechAllowed(this.policy, item.source, this.now()));
      if (this.current && !speechAllowed(this.policy, this.current.source, this.now())) { this.current = null; this.pausedAt = null; this.next(); }
      else this.changed();
    }
    push(message) {
      const now = this.now();
      if (!message || typeof message.text !== 'string' || !message.text.trim() || message.silent || !speechAllowed(this.policy, message.source, now)) return false;
      const item = { text: message.text.slice(0, 12000), source: message.source || 'notice', request_id: message.request_id,
        duration: Number.isFinite(message.duration) ? Math.max(1000, Math.min(120000, message.duration)) : Math.min(60000, Math.max(8000, message.text.length * 120)), priority: priority(message.source), createdAt: now };
      if (item.request_id && (this.current?.request_id === item.request_id || this.pending.some(entry => entry.request_id === item.request_id))) return false;
      if (IDLE.has(item.source)) this.pending = this.pending.filter(entry => !IDLE.has(entry.source));
      // Direct replies never interrupt another direct reply. Chat may take over an idle/bot bubble;
      // a displaced bot message remains queued with its remaining reading time.
      if (this.current && item.priority > this.current.priority && this.current.priority <= 1) {
        const old = this.current;
        if (!IDLE.has(old.source)) this.pending.push({ ...old, duration: Math.max(3000, old.expiresAt - now) });
        this.current = null; this.pausedAt = null;
      }
      if (this.pending.length >= this.maxPending) {
        let drop = -1;
        for (let i = 0; i < this.pending.length; i++) if (drop < 0 || this.pending[i].priority < this.pending[drop].priority) drop = i;
        if (drop >= 0 && this.pending[drop].priority <= item.priority) this.pending.splice(drop, 1);
        else return false;
      }
      this.pending.push(item);
      this.pending.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      if (!this.current) this.next(); else this.changed();
      return true;
    }
    next() {
      this.current = null; this.pausedAt = null;
      while (this.pending.length) {
        const item = this.pending.shift();
        if (speechAllowed(this.policy, item.source, this.now())) { this.current = { ...item, expiresAt: this.now() + item.duration }; this.pausedAt = this.hovered ? this.now() : null; break; }
      }
      this.changed();
    }
    dismiss() { this.next(); }
    setPaused(paused) {
      this.hovered = Boolean(paused);
      if (!this.current) return;
      if (paused && this.pausedAt === null) this.pausedAt = this.now();
      else if (!paused && this.pausedAt !== null) { this.current.expiresAt += this.now() - this.pausedAt; this.pausedAt = null; }
      this.changed();
    }
    tick() { if (this.current && this.pausedAt === null && this.now() >= this.current.expiresAt) this.next(); }
    clearPassive() {
      this.pending = this.pending.filter(item => !PASSIVE.has(item.source));
      if (this.current && PASSIVE.has(this.current.source)) this.next(); else this.changed();
    }
  }
  return { SpeechQueue, speechAllowed, priority };
});
