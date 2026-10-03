package com.acme.portal.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.AgentChatResponse;
import com.swfte.sdk.models.WorkflowInvocation;
import com.swfte.sdk.resources.Agents;
import com.swfte.sdk.resources.Workflows;
import java.util.Map;
import org.junit.jupiter.api.Test;

class OrderServiceTest {

    @Test
    void submitInvokesTheOrderWorkflow() {
        SwfteClient client = mock(SwfteClient.class);
        Workflows workflows = mock(Workflows.class);
        when(client.workflows()).thenReturn(workflows);
        when(workflows.invoke(eq("wf_JvOrd1"), anyMap())).thenReturn(new WorkflowInvocation("ex-1", "wf_JvOrd1", "QUEUED", Map.of()));

        assertThat(new OrderService(client).submit("o-1", "sku-9")).isEqualTo("ex-1");
        verify(workflows).invoke("wf_JvOrd1", Map.of("orderId", "o-1", "sku", "sku-9"));
    }

    @Test
    void supportAnswersFromTheAgent() {
        SwfteClient client = mock(SwfteClient.class);
        Agents agents = mock(Agents.class);
        when(client.agents()).thenReturn(agents);
        when(agents.chat("ag_JvSup1", "hi")).thenReturn(new AgentChatResponse("hello", "c-1", Map.of()));

        assertThat(new SupportService(client, null).answer("hi")).isEqualTo("hello");
    }
}
