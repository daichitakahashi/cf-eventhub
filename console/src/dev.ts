import { createWebConsole } from ".";

const handler = createWebConsole({
  dateFormatter: new Intl.DateTimeFormat("ja", {
    dateStyle: "short",
    timeStyle: "long",
  }),
  color: "#45c467",
  environment: "dev-eventhub",
  eventTitle: (e) =>
    typeof e.payload === "object" &&
    e.payload !== null &&
    "eventName" in e.payload &&
    typeof e.payload.eventName === "string"
      ? e.payload.eventName
      : e.id,
});

export default handler;
