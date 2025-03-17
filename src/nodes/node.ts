import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";

export async function node(
  nodeId: number, // the ID of the node
  N: number, // total number of nodes in the network
  F: number, // number of faulty nodes in the network
  initialValue: Value, // initial value of the node
  isFaulty: boolean, // true if the node is faulty, false otherwise
  nodesAreReady: () => boolean, // used to know if all nodes are ready to receive requests
  setNodeIsReady: (index: number) => void // this should be called when the node is started and ready to receive requests
) {
  const node = express();
  node.use(express.json());
  node.use(bodyParser.json());

  // State du nœud
  const state = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0
  };

  // Utilisé pour stocker les messages reçus en phase 1 et 2
  const messages = {
    phase1: [] as { value: Value, k: number }[],
    phase2: [] as { value: Value, k: number }[]
  };

  // cette route permet de récupérer le statut actuel du nœud
  node.get("/status", (req, res) => {
    if (isFaulty) {
      res.status(500).send("faulty");
    } else {
      res.status(200).send("live");
    }
  });

  // cette route permet au nœud de recevoir des messages d'autres nœuds
  node.post("/message", (req, res) => {
    if (isFaulty || state.killed) {
      return res.status(500).send("Cannot process message, node is faulty or killed");
    }

    const { phase, value, k } = req.body;

    if (k === state.k) {
      if (phase === 1) {
        messages.phase1.push({ value, k });
      } else if (phase === 2) {
        messages.phase2.push({ value, k });
      }
    }

    res.status(200).send("Message received");
  });

  // cette route est utilisée pour démarrer l'algorithme de consensus
  node.get("/start", async (req, res) => {
    if (isFaulty || state.killed) {
      return res.status(500).send("Cannot start, node is faulty or killed");
    }

    // Attendre que tous les nœuds soient prêts
    while (!nodesAreReady()) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Démarrer l'algorithme Ben-Or
    runBenOrAlgorithm();

    res.status(200).send("Consensus algorithm started");
  });

  // cette route est utilisée pour arrêter l'algorithme de consensus
  node.get("/stop", async (req, res) => {
    state.killed = true;
    res.status(200).send("Node stopped");
  });

  // récupérer l'état actuel d'un nœud
  node.get("/getState", (req, res) => {
    res.status(200).json(state);
  });

  // Implémentation de l'algorithme Ben-Or
  async function runBenOrAlgorithm() {
    while (!state.decided && !state.killed) {
      // Phase 1: Broadcast value to all nodes
      await phase1();
      
      // Phase 2: Collect values and decide
      await phase2();
      
      // Increment round counter
      if (state.k !== null) {
        state.k++;
      }
    }
  }

  async function phase1() {
    if (state.killed) return;
    
    // Vider les messages précédents
    messages.phase1 = [];
    
    // Envoyer la valeur actuelle à tous les nœuds
    for (let i = 0; i < N; i++) {
      try {
        await fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phase: 1, value: state.x, k: state.k })
        });
      } catch (error) {
        // Ignorer les nœuds qui ne répondent pas (probablement en panne)
      }
    }
    
    // Attendre suffisamment de messages
    await waitForMessages(N - F, messages.phase1);
  }

  async function phase2() {
    if (state.killed) return;
    
    // Vider les messages précédents
    messages.phase2 = [];
    
    // Prendre une décision basée sur les messages reçus en phase 1
    let newValue: Value = "?";
    
    const valueCount0 = messages.phase1.filter(m => m.value === 0).length;
    const valueCount1 = messages.phase1.filter(m => m.value === 1).length;
    
    if (valueCount0 > (N + F) / 2) {
      newValue = 0;
    } else if (valueCount1 > (N + F) / 2) {
      newValue = 1;
    } else {
      // Si pas de majorité, choisir aléatoirement
      newValue = Math.random() < 0.5 ? 0 : 1;
    }
    
    // Mettre à jour la valeur du nœud
    state.x = newValue;
    
    // Envoyer la nouvelle valeur à tous les nœuds
    for (let i = 0; i < N; i++) {
      try {
        await fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phase: 2, value: newValue, k: state.k })
        });
      } catch (error) {
        // Ignorer les nœuds qui ne répondent pas
      }
    }
    
    // Attendre suffisamment de messages
    await waitForMessages(N - F, messages.phase2);
    
    // Vérifier si une décision peut être prise
    const phase2ValueCount0 = messages.phase2.filter(m => m.value === 0).length;
    const phase2ValueCount1 = messages.phase2.filter(m => m.value === 1).length;
    
    if (phase2ValueCount0 > (N + F) / 2) {
      state.x = 0;
      state.decided = true;
    } else if (phase2ValueCount1 > (N + F) / 2) {
      state.x = 1;
      state.decided = true;
    }
  }

  async function waitForMessages(threshold: number, messageArray: any[]) {
    const maxWaitTime = 1000; // 1 seconde max
    const startTime = Date.now();
    
    while (messageArray.length < threshold && !state.killed) {
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Si on a attendu trop longtemps, on abandonne
      if (Date.now() - startTime > maxWaitTime) {
        break;
      }
    }
  }

  // start the server
  const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(
      `Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`
    );

    // the node is ready
    setNodeIsReady(nodeId);
  });

  return server;
}
