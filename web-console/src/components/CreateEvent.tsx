import type { FC } from "hono/jsx";

export const CreateEvent: FC = () => {
  const placeholder = JSON.stringify(
    {
      name: "My Event",
      payload: {
        message: "Hello, world!",
      },
    },
    null,
    2,
  );
  return (
    <div>
      <h3 class="title is-6 has-text-weight-semibold my-2">
        Enter your payload here:
      </h3>
      <form>
        <textarea
          name="payload"
          class="textarea is-dark mb-2"
          placeholder={placeholder}
          rows={10}
          minlength={1}
          _="
            on input
            if event.target.value != ''
              remove @disabled from #submit
            else
              add @disabled='true' to #submit
            end
          "
        />
        <button
          id="submit"
          type="submit"
          class="button is-warning"
          hx-post="/api/events"
          hx-confirm="Are you sure you wish to create new event?"
          _="on htmx:beforeSend add .is-loading then add @disabled='true'"
          disabled
        >
          Create event
        </button>
      </form>
    </div>
  );
};
