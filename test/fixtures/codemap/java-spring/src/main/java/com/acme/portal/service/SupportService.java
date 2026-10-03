package com.acme.portal.service;

import com.acme.portal.config.SwfteIds;
import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.AgentChatOptions;
import com.swfte.sdk.models.AgentChatResponse;
import java.util.List;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;

@Service
public class SupportService {

    private final SwfteClient client;
    private final SwfteIds ids;

    public SupportService(SwfteClient client, SwfteIds ids) {
        this.client = client;
        this.ids = ids;
    }

    public String answer(String message) {
        AgentChatResponse reply = client.agents().chat("ag_JvSup1", message);
        return reply.getResponse();
    }

    public String answerInThread(String message, String userId, String conversationId) {
        AgentChatResponse reply = client.agents().chat("ag_JvSup1", message,
                AgentChatOptions.builder().userId(userId).conversationId(conversationId).build());
        return reply.getResponse();
    }

    public List<String> answerAll(List<String> messages) {
        return messages.stream()
                .map(m -> client.agents().chat("ag_JvSup1", m).getResponse())
                .collect(Collectors.toList());
    }

    public String escalate(String summary) {
        return client.agents().chat("ag_JvEsc2", summary).getResponse();
    }

    public String escalateConfigured(String summary) {
        return client.agents().chat(ids.getEscalationAgent(), summary).getResponse();
    }
}
