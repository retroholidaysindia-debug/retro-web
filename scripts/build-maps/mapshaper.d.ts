declare module "mapshaper" {
  const mapshaper: {
    applyCommands(
      command: string,
      input: Record<string, string>
    ): Promise<Record<string, string>>;
  };
  export default mapshaper;
}
