import type { Child, FC } from "hono/jsx";

export const useNotification = ({
  id,
  onDismiss = "",
}: { id: string; onDismiss?: string }) => {
  const Notification: FC<{
    icon: ReturnType<FC>;
    children: Child;
  }> = ({ icon, children }) => (
    <div
      id={id}
      class="fixed inset-x-0 mx-auto top-8 h-0 flex justify-center"
      style="display: none;"
      _="
        on notify(open)
          if open show me 
          else hide me
      "
    >
      <div class="z-[999] w-fit flex items-center text-white rounded-full bg-black drop-shadow-xl pl-4 pr-2 py-6">
        <div>{icon}</div>
        <div class="text-white px-2 py-1">{children}</div>
        <button
          class="rounded-full ml-1 px-2 py-1 hover:bg-gray-900 select-none"
          type="button"
          _={`
            on click
              send notify(open:false) to #${id}
              ${onDismiss}
            end
          `}
        >
          dismiss
        </button>
      </div>
    </div>
  );

  const openNotification = `send notify(open:true) to #${id}`;
  return [Notification, openNotification] as const;
};
