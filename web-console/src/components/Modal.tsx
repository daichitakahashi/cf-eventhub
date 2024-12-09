import type { FC } from "hono/jsx";

import type { Node } from "./types";

export const Modal: FC<{
  target: (_: string) => Node;
  children: (_: string) => Node;
}> = ({ target, children }) => (
  <div>
    {target(`
        on click set dialog to the next <dialog/>
        if dialog does not match @open
          call dialog.showModal()
        end
      `)}
    <dialog class="outline-none rounded-xl backdrop:bg-gray-100/30 backdrop:backdrop-blur-[2px]">
      <div class="m-[1px] p-4 rounded-xl outline outline-1 outline-gray-900/20">
        {children(`
          on click
          set dialog to closest <dialog/>
          if dialog match @open
            call dialog.close()
          end
        `)}
      </div>
    </dialog>
  </div>
);