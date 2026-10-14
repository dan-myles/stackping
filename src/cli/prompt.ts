import { createInterface } from "node:readline/promises"

const bold = (text: string) => `\x1b[1m${text}\x1b[22m`
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`
const green = (text: string) => `\x1b[32m${text}\x1b[39m`
const red = (text: string) => `\x1b[31m${text}\x1b[39m`
const cyan = (text: string) => `\x1b[36m${text}\x1b[39m`

export const style = { bold, dim, green, red, cyan }

export function heading(text: string): void {
  console.log(`\n${bold(cyan("◆"))} ${bold(text)}`)
}

export function note(text: string): void {
  for (const line of text.split("\n")) console.log(`  ${dim(line)}`)
}

export function success(text: string): void {
  console.log(`  ${green("✓")} ${text}`)
}

export function failure(text: string): void {
  console.log(`  ${red("✕")} ${text}`)
}

export async function ask(
  question: string,
  options: {
    default?: string
    validate?: (value: string) => string | null
  } = {},
): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    while (true) {
      const suffix = options.default ? dim(` (${options.default})`) : ""
      const answer =
        (await rl.question(`  ${question}${suffix} `)).trim() ||
        options.default ||
        ""
      const problem = options.validate?.(answer) ?? null
      if (problem === null) return answer
      failure(problem)
    }
  } finally {
    rl.close()
  }
}

export async function confirm(
  question: string,
  fallback = true,
): Promise<boolean> {
  const answer = await ask(`${question} ${dim(fallback ? "[Y/n]" : "[y/N]")}`)
  if (!answer) return fallback
  return /^y(es)?$/i.test(answer)
}

/** Reads a line without echoing it, for tokens and secrets. */
export async function askSecret(
  question: string,
  options: {
    optional?: boolean
    validate?: (value: string) => string | null
  } = {},
): Promise<string> {
  while (true) {
    const value = await readHidden(`  ${question} `)
    if (!value && options.optional) return ""
    const problem = value
      ? (options.validate?.(value) ?? null)
      : "A value is required"
    if (problem === null) return value
    failure(problem)
  }
}

function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin
  process.stdout.write(prompt)
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = createInterface({ input: stdin })
      rl.once("line", (line) => {
        rl.close()
        resolve(line.trim())
      })
    })
  }
  return new Promise((resolve, reject) => {
    let value = ""
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          cleanup()
          process.stdout.write("\n")
          resolve(value.trim())
          return
        }
        if (character === "\u0003") {
          cleanup()
          process.stdout.write("\n")
          reject(new Error("Cancelled"))
          return
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write("\b \b")
          }
          continue
        }
        value += character
        process.stdout.write("•")
      }
    }
    const cleanup = () => {
      stdin.off("data", onData)
      stdin.setRawMode(false)
      stdin.pause()
    }
    stdin.on("data", onData)
  })
}
