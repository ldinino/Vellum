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
            "Meeting notes",
            "Turn rough notes into meeting notes",
            "Reorganize the text into structured meeting notes. Output Markdown with a \
             short \"## \" heading for each part the text supports — typically \
             Attendees, Discussion, Decisions, and Action items — with bullet points \
             under each. Include only sections the text actually supports; omit the \
             rest. Keep every fact; never invent names, dates, decisions, or tasks. \
             Bold the owner of each action item with **double asterisks**.",
            vec![
                ex(
                    "ok so met with priya and sam about the launch. we agreed to push the date to march 3. priya will redo the landing page copy, sam is handling the press list. still an open question on budget for ads. also we should loop in finance before next week.",
                    "## Attendees\n- Priya\n- Sam\n\n## Decisions\n- Launch date pushed to **March 3**\n\n## Action items\n- **Priya**: redo the landing page copy\n- **Sam**: handle the press list\n- Loop in **Finance** before next week\n\n## Open questions\n- Budget for ads",
                ),
            ],
        ),
        tmpl(
            "Action items",
            "Pull out the to-dos",
            "Extract the actionable tasks from the text as a Markdown bulleted list, one \
             task per line starting with \"- \". When the text names who owns a task, \
             bold that name with **double asterisks** at the start of the bullet. \
             Include only real tasks stated in the text; do not invent tasks or add a \
             heading. Do not use checkboxes.",
            vec![
                ex(
                    "Before the demo we need to freeze the build, and Dana said she'd write the script. I'll book the room. Someone has to test the projector — probably me. The slides are already done.",
                    "- Freeze the build\n- **Dana**: write the script\n- Book the room\n- Test the projector",
                ),
            ],
        ),
        tmpl(
            "Structure into sections",
            "Reorganize a brain dump into labelled sections",
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
