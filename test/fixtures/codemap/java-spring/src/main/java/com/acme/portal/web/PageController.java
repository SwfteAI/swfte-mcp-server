package com.acme.portal.web;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class PageController {

    @Value("${swfte.agents.support}")
    private String supportAgentId;

    @GetMapping("/")
    public String portal() {
        return "portal";
    }

    @GetMapping("/support")
    public String support() {
        return "support";
    }

    @GetMapping("/account")
    public String account(Model model) {
        model.addAttribute("supportAgentId", supportAgentId);
        return "account";
    }

    @GetMapping("/help")
    public String help() {
        return "agent-embed";
    }
}
