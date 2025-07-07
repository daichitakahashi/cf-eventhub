import type { Child, FC } from "hono/jsx";

export const Modal: FC<{
  target: (_: string) => Child;
  children: (_: string) => Child;
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

const modalId = "dispatch-detail-modal";
const modalFrameId = `modal-frame-${modalId}`;

export const openModalScript = (contentFrameId: string) => `
  on click
    set dialog to #${modalId}
    set frame to #${modalFrameId}
    if dialog does not match @open
      put innerHTML of #${contentFrameId} into frame
      call htmx.process(frame)
      call dialog.showModal()
    end
`;

export const useSharedModal = () => {
  const SharedModal: FC = () => (
    <dialog
      id={modalId}
      class="outline-none rounded-xl backdrop:bg-gray-100/30 backdrop:backdrop-blur-[2px]"
    >
      <div
        id={modalFrameId}
        class="m-[1px] p-4 rounded-xl outline outline-1 outline-gray-900/20"
      />
    </dialog>
  );

  return SharedModal;
};

export const SharedModalContent: FC<{
  contentFrameId: string;
  trigger: (openModalScript: string) => Child;
  children: Child;
}> = ({ contentFrameId, trigger, children }) => {
  const script = openModalScript(contentFrameId);
  return (
    <div>
      {trigger(script)}
      <template id={contentFrameId}>{children}</template>
    </div>
  );
};
