import { spawn } from "node:child_process";

/**
 * @param {() => Promise<void>} onExit
 * @returns Promise<void>
 */
export const waitExit = (onExit) =>
  new Promise((resolve, reject) => {
    let done = false;
    const handler = async () => {
      try {
        if (!done) {
          done = true;
          await onExit();
          resolve();
        }
      } catch (e) {
        reject(e);
      }
    };
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
    process.once("SIGQUIT", handler);
  });

/**
 *
 * @param { string } cmd
 * @param { {
 *   name: string
 *   dir: string
 *   chalk: ChalkInstance
 * } } args
 * @returns
 */
export const exec = (cmd, { name, dir, chalk }) => {
  const cwd = process.cwd();
  process.chdir(dir);
  const p = spawn(cmd, { shell: true });
  process.chdir(cwd);

  p.stdout.on("data", (data) => {
    process.stdout.write(`${chalk(`${name}`)}: ${data}`);
  });
  p.stderr.on("data", (data) => {
    process.stderr.write(`${chalk(`${name}`)}: ${data}`);
  });

  const exitPromise = new Promise((resolve) => {
    p.on("exit", () => {
      console.log(`${chalk(`${name}`)}: process exited`);
      resolve();
    });
  });

  return {
    process: p,
    exit: exitPromise,
  };
};
