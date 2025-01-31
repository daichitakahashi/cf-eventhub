import { createWebConsole } from ".";

const handler = createWebConsole({
  dateFormatter: new Intl.DateTimeFormat("ja", {
    dateStyle: "short",
    timeStyle: "long",
  }),
  color: "#45c467",
  environment: "dev-eventhub",
});

export default handler;
