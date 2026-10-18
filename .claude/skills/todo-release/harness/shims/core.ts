type Impl = (cmd: string, args?: unknown) => Promise<unknown>;
let impl: Impl = async () => null;
export const invoke = Object.assign(
  (cmd: string, args?: unknown) => impl(cmd, args),
  {
    mockImplementation(f: Impl) {
      impl = f;
    },
  },
);
