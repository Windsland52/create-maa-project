export function testChildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CREATE_MAA_PROJECT_DOWNLOAD_ATTEMPTS: '1'
  }
}
