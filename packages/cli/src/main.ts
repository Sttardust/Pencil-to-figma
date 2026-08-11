import { runDoctor } from "./commands/doctor.js";
import {
  runVisualCompare,
  visualCompareUsage,
} from "./commands/visual-compare.js";

const command = process.argv[2];
if (command === "doctor") {
  process.exitCode = await runDoctor();
} else if (command === "visual-compare") {
  process.exitCode = await runVisualCompare(process.argv.slice(3));
} else {
  console.error(
    `Usage: pen-fig <doctor|visual-compare>\n\n${visualCompareUsage()}`,
  );
  process.exitCode = 2;
}
