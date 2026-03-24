/**
 * PeerJS wrapper for P2P multiplayer auction.
 * Host creates a room, guests join with a code.
 * All game logic runs on the host's browser.
 */

import Peer, { DataConnection } from "peerjs";

const ROOM_PREFIX = "ipl-sim-";

/** Generate a 6-character room code */
function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 to avoid confusion
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export type MessageHandler = (peerId: string, data: unknown) => void;
export type ConnectionHandler = (peerId: string) => void;
export type DisconnectHandler = (peerId: string) => void;

export class MultiplayerHost {
  private peer: Peer | null = null;
  private connections = new Map<string, DataConnection>();
  roomCode: string = "";

  onMessage: MessageHandler = () => {};
  onConnection: ConnectionHandler = () => {};
  onDisconnect: DisconnectHandler = () => {};

  async create(): Promise<string> {
    this.roomCode = generateRoomCode();
    const peerId = ROOM_PREFIX + this.roomCode;

    return new Promise((resolve, reject) => {
      this.peer = new Peer(peerId);

      this.peer.on("open", () => {
        console.log("[Host] Room created:", this.roomCode);
        resolve(this.roomCode);
      });

      this.peer.on("connection", (conn) => {
        conn.on("open", () => {
          this.connections.set(conn.peer, conn);
          console.log("[Host] Peer connected:", conn.peer);
          this.onConnection(conn.peer);
        });

        conn.on("data", (data) => {
          this.onMessage(conn.peer, data);
        });

        conn.on("close", () => {
          this.connections.delete(conn.peer);
          this.onDisconnect(conn.peer);
        });
      });

      this.peer.on("error", (err) => {
        console.error("[Host] Error:", err);
        reject(err);
      });
    });
  }

  /** Broadcast a message to all connected peers */
  broadcast(data: unknown) {
    const json = JSON.stringify(data);
    for (const conn of this.connections.values()) {
      if (conn.open) conn.send(JSON.parse(json));
    }
  }

  /** Send to a specific peer */
  sendTo(peerId: string, data: unknown) {
    const conn = this.connections.get(peerId);
    if (conn?.open) conn.send(data);
  }

  /** Get connected peer count */
  get peerCount(): number {
    return this.connections.size;
  }

  destroy() {
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.peer?.destroy();
    this.peer = null;
  }
}

export class MultiplayerGuest {
  private peer: Peer | null = null;
  private connection: DataConnection | null = null;
  peerId: string = "";

  onMessage: (data: unknown) => void = () => {};
  onDisconnect: () => void = () => {};

  async join(roomCode: string, playerName: string): Promise<void> {
    const hostPeerId = ROOM_PREFIX + roomCode.toUpperCase();

    return new Promise((resolve, reject) => {
      this.peer = new Peer();

      this.peer.on("open", (id) => {
        this.peerId = id;
        console.log("[Guest] My peer ID:", id);

        const conn = this.peer!.connect(hostPeerId, { reliable: true });

        conn.on("open", () => {
          this.connection = conn;
          console.log("[Guest] Connected to host");
          // Send join message
          conn.send({ type: "join", name: playerName });
          resolve();
        });

        conn.on("data", (data) => {
          this.onMessage(data);
        });

        conn.on("close", () => {
          this.onDisconnect();
        });

        conn.on("error", (err) => {
          reject(err);
        });
      });

      this.peer.on("error", (err) => {
        console.error("[Guest] Error:", err);
        reject(err);
      });

      // Timeout after 10 seconds
      setTimeout(() => reject(new Error("Connection timeout")), 10000);
    });
  }

  /** Send a message to the host */
  send(data: unknown) {
    if (this.connection?.open) this.connection.send(data);
  }

  destroy() {
    this.connection?.close();
    this.peer?.destroy();
    this.peer = null;
  }
}
