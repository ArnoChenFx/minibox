import { Duplex } from "node:stream";

/** The part of a WebSocket the adapter writes to. Bun's server socket has these, with the same return values. */
export interface FrameSocket {
  /** Bytes queued or sent; `-1` when the socket queued the frame under backpressure, and `0` when it is closed. */
  send(data: Uint8Array): number;
  close(code?: number, reason?: string): void;
}

export interface PeerAddress {
  readonly address: string;
  readonly family: string;
  readonly port: number;
}

/**
 * Carries an SSH byte stream over a WebSocket: each binary message is a chunk of the stream, in either direction. A send
 * that the socket queued holds the next write until the owner reports drain, so memory stays bounded however slowly the
 * peer reads.
 */
export class WsDuplex extends Duplex {
  readonly remoteAddress: string | undefined;
  readonly remoteFamily: string | undefined;
  readonly remotePort: number | undefined;
  private waiting: (() => void) | null = null;
  private socketClosed = false;
  private peerGone = false;

  constructor(
    private readonly socket: FrameSocket,
    peer?: PeerAddress,
  ) {
    super();
    this.remoteAddress = peer?.address;
    this.remoteFamily = peer?.family;
    this.remotePort = peer?.port;
  }

  onMessage(data: Uint8Array): void {
    this.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  onDrain(): void {
    const resume = this.waiting;
    this.waiting = null;
    resume?.();
  }

  /** The peer closed the WebSocket: end the reader and release any write that was waiting on it. */
  onClosed(): void {
    if (this.peerGone) return;
    this.peerGone = true;
    this.socketClosed = true;
    this.push(null);
    this.onDrain();
    this.destroy();
  }

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const sent = this.socket.send(chunk);
    if (sent === 0) {
      callback(new Error("the websocket is closed"));
      return;
    }
    if (sent === -1) {
      this.waiting = () => callback();
      return;
    }
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.closeSocket(1000, "ssh finished");
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.onDrain();
    this.closeSocket(1011, "ssh closed");
    callback(error);
  }

  private closeSocket(code: number, reason: string): void {
    if (this.socketClosed) return;
    this.socketClosed = true;
    try {
      this.socket.close(code, reason);
    } catch {
      // The socket already closed.
    }
  }
}
