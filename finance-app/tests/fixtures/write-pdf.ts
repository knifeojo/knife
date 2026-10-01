import { writeFileSync } from "node:fs";
import { PAGE1, PAGE2, makeStatementPdf } from "./statement-pdf";
writeFileSync(process.argv[2], await makeStatementPdf([PAGE1, PAGE2]));
