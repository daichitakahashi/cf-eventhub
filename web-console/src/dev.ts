import { createWebConsole } from ".";

const handler = createWebConsole({
  dateFormatter: new Intl.DateTimeFormat("ja", {
    dateStyle: "short",
    timeStyle: "long",
  }),
});

export default handler;
