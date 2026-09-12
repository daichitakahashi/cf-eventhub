import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = "daichitakahashi/cf-eventhub";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readmes = [
  "README.md",
  "cf-eventhub/README.md",
  "web-console/README.md",
];

const revision = (
  process.env.GITHUB_SHA ??
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  })
).trim();

if (!/^[0-9a-f]{40}$/i.test(revision)) {
  throw new Error(`Invalid Git commit SHA: ${revision}`);
}

const markdownLink = /(!?\[[^\]]*\]\()([^\s)]+)(\))/g;

for (const readme of readmes) {
  const filename = path.join(root, readme);
  const source = await readFile(filename, "utf8");
  const contents = source.replace(
    markdownLink,
    (match, prefix, destination, suffix) => {
      if (!destination.startsWith("./") && !destination.startsWith("../")) {
        return match;
      }

      const fragmentAt = destination.search(/[?#]/);
      const relativeTarget =
        fragmentAt === -1 ? destination : destination.slice(0, fragmentAt);
      const fragment = fragmentAt === -1 ? "" : destination.slice(fragmentAt);
      const target = path.resolve(path.dirname(filename), relativeTarget);
      const repositoryPath = path.relative(root, target);

      if (repositoryPath.startsWith("..") || path.isAbsolute(repositoryPath)) {
        throw new Error(
          `${readme}: link points outside the repository: ${destination}`,
        );
      }

      const encodedPath = repositoryPath
        .split(path.sep)
        .map(encodeURIComponent)
        .join("/");
      const baseUrl = prefix.startsWith("!")
        ? `https://raw.githubusercontent.com/${repository}/${revision}`
        : `https://github.com/${repository}/blob/${revision}`;

      return `${prefix}${baseUrl}/${encodedPath}${fragment}${suffix}`;
    },
  );

  if (contents !== source) {
    await writeFile(filename, contents);
    console.log(`Pinned relative links in ${readme} to ${revision}`);
  }
}
