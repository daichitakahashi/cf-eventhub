import type { Child, FC } from "hono/jsx";

export const DescriptionList: FC<{ children: Child }> = ({ children }) => (
  <div class="mt-6 border-gray-200">
    <dl class="divide-y divide-gray-200">{children}</dl>
  </div>
);

export const Description: FC<{ title: string; children: Child }> = ({
  title,
  children,
}) => (
  <div class="px-4 py-4 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0">
    <dt class="text-sm/6 font-medium text-gray-900">{title}</dt>
    <dd class="mt-1 text-sm/6 text-gray-700 sm:col-span-2 sm:mt-0">
      {children}
    </dd>
  </div>
);
