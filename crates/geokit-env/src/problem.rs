// The one error of the crate. The page cannot word anything in the reader's
// language from a bare string, so what goes wrong is a code and what fills
// it, which the app words through its strings as `problem.<code>`, with the
// English alongside for logs and tests. It mirrors `Problem` in
// `@geokit/viewer` (`code`, `english`, `params`), and serialises as that.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

/// What fills a Problem's words: some text or a number.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Param {
    Text(String),
    Number(i64),
}

impl From<&str> for Param {
    fn from(s: &str) -> Self {
        Param::Text(s.into())
    }
}
impl From<String> for Param {
    fn from(s: String) -> Self {
        Param::Text(s)
    }
}
impl From<i64> for Param {
    fn from(n: i64) -> Self {
        Param::Number(n)
    }
}
impl From<i32> for Param {
    fn from(n: i32) -> Self {
        Param::Number(n.into())
    }
}
impl From<usize> for Param {
    fn from(n: usize) -> Self {
        Param::Number(n as i64)
    }
}

/// An error a person may read: a dotted code (the module first, as in
/// `env.quote`), the English, and what fills the words, by name.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Problem {
    pub code: String,
    pub english: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, Param>,
}

impl Problem {
    pub fn new(code: &str, english: impl Into<String>) -> Self {
        Problem {
            code: code.into(),
            english: english.into(),
            params: BTreeMap::new(),
        }
    }

    /// `name` filled with `value`.
    pub fn with(mut self, name: &str, value: impl Into<Param>) -> Self {
        self.params.insert(name.into(), value.into());
        self
    }

    /// Caused by `cause`: its English kept as the `cause` parameter.
    pub fn because(self, cause: impl fmt::Display) -> Self {
        self.with("cause", cause.to_string())
    }
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.english)
    }
}

impl std::error::Error for Problem {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_as_the_viewers_problem() {
        let p = Problem::new("env.quote", "a quote")
            .with("name", "x")
            .with("n", 2);
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"code":"env.quote","english":"a quote","params":{"n":2,"name":"x"}}"#
        );
        assert_eq!(p.to_string(), "a quote");
        let bare = serde_json::to_string(&Problem::new("a.b", "c")).unwrap();
        assert_eq!(bare, r#"{"code":"a.b","english":"c"}"#);
    }
}
