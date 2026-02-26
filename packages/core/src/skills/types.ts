export interface SkillMetadata {
  /** Skill name — kebab-case, matches parent directory name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Absolute path to SKILL.md file */
  path: string;
  /** Directory containing the SKILL.md */
  baseDir: string;
  /** Where this skill was discovered */
  source: "global" | "project" | "agents" | "config";
  /** Whether the LLM can autonomously decide to use this skill */
  disableModelInvocation: boolean;
}

export interface SkillLoadResult {
  skills: SkillMetadata[];
  errors: SkillLoadError[];
}

export interface SkillLoadError {
  path: string;
  message: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  "disable-model-invocation"?: boolean;
}
