export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(`mailguard stub: from=${message.from} to=${message.to}`);
    await message.forward(env.FORWARD_TO);
  },
};
