/**
 * Room data model and operations.
 */

export interface VideoSource {
  type: "file" | "hls" | "youtube" | "vimeo";
  url: string;
  label?: string;
}

/**
 * A selectable audio track (e.g. a language) that plays in sync with the
 * single video file, so a 2GB movie only needs one upload plus small audio files.
 */
export interface AudioTrack {
  label: string;
  url: string;
}

export interface Participant {
  id: string;
  displayName: string;
  joinedAt: number;
  lastHeartbeat: number;
  reportedPosition: number;
  drift: number;
  latency: number;
  isBuffering: boolean;
  isKicked: boolean;
}

export interface PlaybackState {
  isPlaying: boolean;
  position: number;
  lastUpdated: number;
  playbackRate: number;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: number;
}

export interface RoomData {
  id: string;
  hostId: string | null;
  videoSource: VideoSource;
  audioTracks: AudioTrack[];
  participants: Map<string, Participant>;
  playbackState: PlaybackState;
  linkedRoomId: string | null;
  chatHistory: ChatMessage[];
  createdAt: number;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_PARTICIPANTS = parseInt(
  process.env.ROOM_MAX_PARTICIPANTS || "3",
  10
);

export class Room {
  public data: RoomData;

  constructor(id: string, videoSource: VideoSource, audioTracks: AudioTrack[] = []) {
    this.data = {
      id,
      hostId: null,
      videoSource,
      audioTracks,
      participants: new Map(),
      playbackState: {
        isPlaying: false,
        position: 0,
        lastUpdated: Date.now(),
        playbackRate: 1.0,
      },
      linkedRoomId: null,
      chatHistory: [],
      createdAt: Date.now(),
      cleanupTimer: null,
    };
  }

  /**
   * Adds a participant to the room.
   * Returns the participant on success, or null if room is full.
   */
  addParticipant(id: string, displayName: string): Participant | null {
    // Check if participant is kicked
    for (const [, p] of this.data.participants) {
      if (p.displayName === displayName && p.isKicked) {
        return null;
      }
    }

    // Check capacity (only count active, non-kicked participants)
    if (this.getParticipantCount() >= MAX_PARTICIPANTS) {
      return null;
    }

    const participant: Participant = {
      id,
      displayName,
      joinedAt: Date.now(),
      lastHeartbeat: Date.now(),
      reportedPosition: 0,
      drift: 0,
      latency: 0,
      isBuffering: false,
      isKicked: false,
    };

    this.data.participants.set(id, participant);

    // First participant becomes host
    if (this.data.hostId === null) {
      this.data.hostId = id;
    }

    // Cancel cleanup timer if room was empty
    if (this.data.cleanupTimer !== null) {
      clearTimeout(this.data.cleanupTimer);
      this.data.cleanupTimer = null;
    }

    return participant;
  }

  /**
   * Removes a participant from the room.
   * Returns true if participant was removed, false if not found.
   */
  removeParticipant(id: string): boolean {
    const removed = this.data.participants.delete(id);

    // If host left, assign next participant as host
    if (removed && this.data.hostId === id) {
      const remaining = Array.from(this.data.participants.keys());
      this.data.hostId = remaining.length > 0 ? remaining[0] : null;
    }

    return removed;
  }

  /**
   * Returns the number of active (non-kicked) participants.
   */
  getParticipantCount(): number {
    let count = 0;
    for (const [, p] of this.data.participants) {
      if (!p.isKicked) {
        count++;
      }
    }
    return count;
  }

  /**
   * Returns a serializable summary of the room for the REST API.
   */
  toPublicInfo() {
    return {
      id: this.data.id,
      videoSourceType: this.data.videoSource.type,
      videoSource: this.data.videoSource,
      audioTracks: this.data.audioTracks,
      participantCount: this.getParticipantCount(),
      maxParticipants: MAX_PARTICIPANTS,
      linkedRoomId: this.data.linkedRoomId,
      createdAt: this.data.createdAt,
    };
  }
}
