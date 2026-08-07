import { runDoctor } from "./commands/doctor.js";

const command = process.argv[2];
if (command === "doctor") {
  process.exitCode = await runDoctor();
} else {
  console.error("Usage: pen-fig <doctor>");
  process.exitCode = 2;
}
