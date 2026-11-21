// ============================================================
// withMedia — optional camera and microphone calls for a P2P room (lab #137)
// ============================================================
//
//   import { RoomTransport } from './room-transport.js';
//   import { withP2P } from './p2p.js';
//   import { withMedia } from './media.js';
//   class GameNet extends withMedia(withP2P(RoomTransport)) { … }
//
// Media rides the PeerJS connection, so it needs the P2P layer under it.
// Options it reads: mediaEnabled (off unless true; when off no stream is ever
// asked for, no call is placed, and an incoming call is closed) and
// audioElement (where the partner's voice plays).
//
//   await net.acquireLocalMedia(camera, mic);   // before or after the upgrade
//   net.onP2PUpgrade = () => net.initiateCall();
//   net.onRemoteStream = (stream) => { video.srcObject = stream; };
//
// Lifted from Tandemonium's room transport with the method bodies unchanged.
// Tandemonium itself no longer loads this layer (Pete, 2026-11-20).
// ============================================================

/**
 * @template {new (...args: any[]) => any} T
 * @param {T} Base  a RoomTransport with the P2P layer
 */
export const withMedia = (Base) => class MediaRoomTransport extends Base {
  constructor(...args) {
    super(...args);
    const options = this.options || {};
    this.onRemoteStream = null;
    this.cameraEnabled = true; // set false to suppress local camera in calls
    this.audioEnabled = false; // set true to include microphone in calls
    // Room camera/mic (#400 D7). When false the transport never acquires a
    // local stream, never places a media call, and closes incoming ones.
    // Data connections are unaffected.
    this.mediaEnabled = !!options.mediaEnabled;
    this._mediaCall = null;
    this._localMediaStream = null;
  }

  _handleIncomingCall(call) {
    // Media off: refuse the call (an older client with media on may still
    // place one) — close it rather than answer, so no MediaConnection opens.
    if (!this.mediaEnabled) {
      try { call.close(); } catch (e) {}
      return;
    }
    // Close previous media call to prevent duplicate streams
    if (this._mediaCall) {
      try { this._mediaCall.close(); } catch (e) {}
    }
    this._mediaCall = call;
    // Answer immediately with pre-acquired stream (from game.js _acquireLocalMedia)
    // to avoid async getUserMedia delay that causes call timeouts on mobile
    if (this._localMediaStream) {
      call.answer(this._localMediaStream);
      this._answeredWithoutMedia = false;
    } else {
      call.answer();
      this._answeredWithoutMedia = true;
    }

    call.on('stream', (remoteStream) => {
      this._playRemoteAudio(remoteStream);
      if (this.onRemoteStream) this.onRemoteStream(remoteStream);
    });
  }

  _playRemoteAudio(stream) {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;
    const audioEl = this.options.audioElement ? this.options.audioElement() : null;
    if (!audioEl) return;
    audioEl.srcObject = stream;
    audioEl.play().catch(() => {});
  }

  async acquireLocalMedia(cameraEnabled, audioEnabled) {
    if (!this.mediaEnabled) return;
    // If stream already has all requested tracks, nothing to do
    if (this._localMediaStream) {
      const hasVideo = this._localMediaStream.getVideoTracks().length > 0;
      const hasAudio = this._localMediaStream.getAudioTracks().length > 0;
      if ((!cameraEnabled || hasVideo) && (!audioEnabled || hasAudio)) return;
      // Need to add missing tracks to the existing stream
      const constraints = {};
      if (cameraEnabled && !hasVideo) constraints.video = { facingMode: 'user', width: 240, height: 240 };
      if (audioEnabled && !hasAudio) constraints.audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      if (Object.keys(constraints).length === 0) return;
      try {
        const extra = await navigator.mediaDevices.getUserMedia(constraints);
        for (const track of extra.getTracks()) {
          this._localMediaStream.addTrack(track);
        }
      } catch (e) { /* denied — continue without */ }
      return;
    }
    const constraints = {};
    if (cameraEnabled) constraints.video = { facingMode: 'user', width: 240, height: 240 };
    if (audioEnabled) constraints.audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (!constraints.video && !constraints.audio) return;
    try {
      this._localMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // Camera/mic denied — continue without media
    }
  }

  initiateCall() {
    if (!this.mediaEnabled) return;
    if (!this.peer || !this.conn) return;
    const localStream = this._localMediaStream || new MediaStream();
    const remotePeerId = this.conn.peer;
    if (!remotePeerId) return;
    // Close previous outgoing call to prevent duplicate streams
    if (this._mediaCall) {
      try { this._mediaCall.close(); } catch (e) {}
    }
    const call = this.peer.call(remotePeerId, localStream);
    if (call) {
      this._mediaCall = call;
      call.on('stream', (remoteStream) => {
        this._playRemoteAudio(remoteStream);
        if (this.onRemoteStream) this.onRemoteStream(remoteStream);
      });
    }
  }

  destroy() {
    // Stop local media tracks
    if (this._localMediaStream) {
      this._localMediaStream.getTracks().forEach(t => t.stop());
      this._localMediaStream = null;
    }
    // Close media call
    if (this._mediaCall) {
      try { this._mediaCall.close(); } catch (e) {}
      this._mediaCall = null;
    }
    // Stop remote audio playback
    const audioEl = this.options.audioElement ? this.options.audioElement() : null;
    if (audioEl) { audioEl.srcObject = null; }
    super.destroy();
  }
};
