import { createWebConsole } from ".";

const handler = createWebConsole({
  dateFormatter: new Intl.DateTimeFormat("ja", {
    dateStyle: "full",
    timeStyle: "long",
  }),
});

export default handler;
