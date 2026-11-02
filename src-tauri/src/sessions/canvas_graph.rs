//! AgentSession ↔ ThoughtDAG 画布图的纯数据映射。
//!
//! ThoughtDAG 的节点是 (question, response)，边表示上下文来源；这里把 IR 的
//! 线性回合映射成一条竖向链，反向则按节点顺序还原问答事件。工具事件不进图，
//! 与 ThoughtDAG 的“思考节点”语义保持一致。

use serde_json::{json, Value};

use super::ir::{Event, EventKind, Session};

/// 把一条会话映射成 ThoughtDAG 可读的 nodes/edges 结构。
pub fn session_to_graph(session: &Session) -> Value {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut pending_question: Option<String> = None;
    let mut last_node: Option<String> = None;

    let mut push_node = |question: String, response: String, nodes: &mut Vec<Value>, edges: &mut Vec<Value>, last: &mut Option<String>| {
        let index = nodes.len();
        let id = format!("n{}", index + 1);
        nodes.push(json!({
            "id": id,
            "type": "thought",
            "position": {"x": 0, "y": index as f64 * 260.0},
            "data": {
                "question": question,
                "response": response,
                "responses": [response.clone()],
                "responseIndex": 0,
                "isCollapsed": false,
                "isEditing": false,
                "isEditingResponse": false,
                "isLoading": false
            }
        }));
        if let Some(previous) = last.take() {
            edges.push(json!({
                "id": format!("e{}", edges.len() + 1),
                "source": previous,
                "target": id,
                "type": "thought"
            }));
        }
        *last = Some(id);
    };

    for event in &session.events {
        match event.kind {
            EventKind::UserPrompt => {
                if let Some(question) = pending_question.take() {
                    push_node(question, String::new(), &mut nodes, &mut edges, &mut last_node);
                }
                pending_question = Some(event.text.clone().unwrap_or_default());
            }
            EventKind::AssistantReply => {
                let question = pending_question.take().unwrap_or_default();
                push_node(
                    question,
                    event.text.clone().unwrap_or_default(),
                    &mut nodes,
                    &mut edges,
                    &mut last_node,
                );
            }
            _ => {}
        }
    }
    if let Some(question) = pending_question {
        push_node(question, String::new(), &mut nodes, &mut edges, &mut last_node);
    }

    json!({
        "version": 1,
        "sourceSessionId": session.id,
        "title": session.title.clone().unwrap_or_default(),
        "nodes": nodes,
        "edges": edges
    })
}

/// 把 ThoughtDAG 的 nodes/edges 还原成一条 IR 会话（用于“画布回合写回”）。
pub fn graph_to_session(graph: &Value, id: &str, cwd: Option<&str>) -> Session {
    let mut events = Vec::new();
    if let Some(nodes) = graph.get("nodes").and_then(Value::as_array) {
        for node in nodes {
            let data = node.get("data").unwrap_or(&Value::Null);
            let question = data
                .get("question")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            let response = data
                .get("response")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if !question.is_empty() {
                events.push(Event {
                    kind: EventKind::UserPrompt,
                    text: Some(question.to_string()),
                    ..Default::default()
                });
            }
            if !response.is_empty() {
                events.push(Event {
                    kind: EventKind::AssistantReply,
                    text: Some(response.to_string()),
                    ..Default::default()
                });
            }
        }
    }
    Session {
        id: id.to_string(),
        runtime: "thoughtdag".to_string(),
        cwd: cwd.map(str::to_string),
        title: graph
            .get("title")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string),
        updated_at: None,
        events,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session {
            id: "ses_a".into(),
            runtime: "opencode".into(),
            cwd: Some("C:/work".into()),
            title: Some("demo".into()),
            updated_at: None,
            events: vec![
                Event { kind: EventKind::UserPrompt, text: Some("q1".into()), ..Default::default() },
                Event { kind: EventKind::AssistantReply, text: Some("a1".into()), ..Default::default() },
                Event { kind: EventKind::ToolUse, tool: Some("read".into()), ..Default::default() },
                Event { kind: EventKind::UserPrompt, text: Some("q2".into()), ..Default::default() },
                Event { kind: EventKind::AssistantReply, text: Some("a2".into()), ..Default::default() },
            ],
        }
    }

    #[test]
    fn maps_turns_to_a_chain() {
        let graph = session_to_graph(&session());
        let nodes = graph["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0]["data"]["question"], "q1");
        assert_eq!(nodes[1]["data"]["response"], "a2");
        assert_eq!(graph["edges"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn round_trips_questions_and_answers() {
        let graph = session_to_graph(&session());
        let restored = graph_to_session(&graph, "ses_b", Some("C:/work"));
        assert_eq!(restored.events.len(), 4);
        assert_eq!(restored.events[0].kind, EventKind::UserPrompt);
        assert_eq!(restored.events[3].text.as_deref(), Some("a2"));
    }

    #[test]
    fn empty_session_yields_empty_graph() {
        let graph = session_to_graph(&Session::default());
        assert!(graph["nodes"].as_array().unwrap().is_empty());
        assert!(graph["edges"].as_array().unwrap().is_empty());
    }
}
