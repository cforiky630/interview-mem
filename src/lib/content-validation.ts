export type ValidationFinding = {
  id: string;
  severity: "error" | "qualification" | "terminology";
  line: number;
  title: string;
  explanation: string;
  suggestion: string;
  sources: { title: string; url: string }[];
};

export type ContentValidation = {
  checkedAt: string;
  sourcePath: string;
  sourceSha256: string;
  reviewedHash: string;
  summary: string;
  findings: ValidationFinding[];
};

export type ContentValidationView = ContentValidation & { current: boolean };
