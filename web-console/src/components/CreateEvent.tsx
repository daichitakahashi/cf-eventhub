import type { FC } from "hono/jsx";

import { Button } from "./Button";
import { SunMedium } from "./Icon";
import { Textarea } from "./Textarea";

export const CreateEvent: FC<{ closeModal: string }> = ({ closeModal }) => {
  const placeholder = JSON.stringify(
    {
      name: "My Event",
      payload: {
        message: "Hello, world!",
      },
    },
    null,
    4,
  );
  return (
    <div>
      <h2 class="text-2xl font-semibold">
        <span class="flex gap-1 items-center">
          <SunMedium title="" /> Create event
        </span>
      </h2>
      <form>
        <div class="my-6">
          <div class="mb-1">Enter your payload here:</div>
          <Textarea
            name="payload"
            placeholder={placeholder}
            cols={60}
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
        </div>
        <div class="flex gap-2">
          <Button
            id="submit"
            type="submit"
            hx-post="/api/events"
            hx-confirm="Are you sure you wish to create new event?"
            hx-disabled-elt="this"
            disabled
          >
            Create
          </Button>
          <Button type="button" _={closeModal} secondary>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
};
