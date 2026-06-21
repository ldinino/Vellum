//! Starter Refine templates (spec Section 8: "ship a few well-crafted starter
//! templates users can clone"). Seeded once into app.json on first load when the
//! library is empty (see `config::load_app_config`); never re-seeded.
//!
//! Each carries a couple of few-shot example pairs — the biggest reliability
//! lever for small models. Formatting templates emit Markdown, which the
//! renderer parses into rich content on apply.

use crate::config::{ExamplePair, RefineTemplate};

fn ex(input: &str, output: &str) -> ExamplePair {
    ExamplePair {
        input: input.into(),
        output: output.into(),
    }
}

fn tmpl(
    name: &str,
    description: &str,
    instructions: &str,
    examples: Vec<ExamplePair>,
) -> RefineTemplate {
    RefineTemplate {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        instructions: instructions.into(),
        examples,
        description: Some(description.into()),
        adherence_override: None,
        system_prompt: String::new(),
    }
}

/// The bundled starter set. Order is the order shown in the Refine menu.
pub fn starter_templates() -> Vec<RefineTemplate> {
    vec![
        tmpl(
            "Tighten",
            "Make the text more concise",
            "Make the text more concise. Cut filler, redundancy, and hedging while \
             preserving every fact and the original meaning. Keep the author's voice, \
             tense, and point of view. Return plain text.",
            vec![
                ex(
                    "I just wanted to quickly reach out and let you know that we are, at this point in time, more or less ready to go ahead and begin the project.",
                    "We're ready to begin the project.",
                ),
                ex(
                    "Due to the fact that it was raining quite heavily, we made the decision to postpone the event until a later date.",
                    "Because of heavy rain, we postponed the event.",
                ),
            ],
        ),
        tmpl(
            "Friendly tone",
            "Warm it up",
            "Rewrite the text in a warm, friendly, approachable tone. Keep all facts and \
             the original meaning; do not add new information. Return plain text.",
            vec![
                ex(
                    "Your request has been denied. Resubmit the form with the missing fields.",
                    "Thanks for sending this over! A few fields were missing, so could you pop those in and resend it? Happy to help if anything's unclear.",
                ),
                ex(
                    "The meeting is moved to 3pm. Do not be late.",
                    "Quick heads-up — we've shifted the meeting to 3pm. See you then!",
                ),
            ],
        ),
        tmpl(
            "Make formal",
            "Professional tone",
            "Rewrite the text in a formal, professional tone suitable for business \
             writing. Keep all facts and the original meaning; do not add new \
             information. Avoid contractions and slang. Return plain text.",
            vec![
                ex(
                    "Hey, just letting you know we can't make the deadline. Sorry!",
                    "I am writing to inform you that we will be unable to meet the agreed deadline. We apologise for any inconvenience this may cause.",
                ),
                ex(
                    "Thanks a ton for the help, you're a lifesaver.",
                    "Thank you very much for your assistance; it is greatly appreciated.",
                ),
            ],
        ),
        tmpl(
            "Bulletize",
            "Turn prose into a bulleted list",
            "Convert the text into a concise bulleted list of its key points. Output \
             Markdown, with each bullet on its own line starting with \"- \". Preserve \
             all facts; do not invent details or add a heading.",
            vec![
                ex(
                    "The release is on Friday. QA needs the build by Wednesday so they have two days to test. Marketing will announce it the following Monday.",
                    "- Release ships Friday\n- QA needs the build by Wednesday (two days to test)\n- Marketing announces the following Monday",
                ),
            ],
        ),
        tmpl(
            "Structure into sections",
            "Reorganize into labelled sections (Markdown)",
            "Reorganize the text into clearly labelled sections. Output Markdown: give \
             each topic a short heading with \"## \", and bold the key term in each \
             point with **double asterisks**. Keep all facts; do not add new \
             information.",
            vec![
                ex(
                    "The kitchen needs new cabinets and a fridge. The bathroom just needs the leaky tap fixed. We should also repaint the hallway.",
                    "## Kitchen\n- New **cabinets**\n- New **fridge**\n\n## Bathroom\n- Fix the **leaky tap**\n\n## Hallway\n- **Repaint**",
                ),
            ],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starters_are_well_formed() {
        let s = starter_templates();
        assert!(s.len() >= 4, "ship several starters");
        for t in &s {
            assert!(!t.id.is_empty());
            assert!(!t.name.is_empty());
            assert!(!t.instructions.is_empty());
            assert!(t.system_prompt.is_empty(), "starters use instructions, not legacy field");
        }
        // ids are unique
        let mut ids: Vec<_> = s.iter().map(|t| t.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), s.len());
    }
}
