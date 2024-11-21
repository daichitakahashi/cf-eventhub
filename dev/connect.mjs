import * as net from "node:net";

export const sleep = (duration) =>
  new Promise((resolve) => setTimeout(resolve, duration));

const retry = async (num, fn) => {
  for (let i = 0; i < num; i++) {
    try {
      await fn();
      return;
    } catch {
      // continue
      await sleep(1000);
    }
  }
  throw new Error("failed to try");
};

/**
 * @param {number} port
 * @param {number} timeout
 * @returns Promise<void>
 */
const connect = (port) =>
  new Promise((resolve, reject) => {
    const socket = new net.Socket();

    const onError = () => {
      socket.destroy();
      reject();
    };

    socket.setTimeout(1000);
    socket.once("error", onError);
    socket.once("timeout", onError);

    socket.connect(port, "localhost", () => {
      socket.end();
      resolve();
    });
  });

/**
 *
 * @param {number} n
 * @param {number} port
 * @returns
 */
export const tryConnect = (n, port) => retry(n, () => connect(port));
