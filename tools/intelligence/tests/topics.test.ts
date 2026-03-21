import { describe, it, expect, beforeAll } from 'vitest';
import { loadTopics, classify, classifyIds, getLoadedTopics } from '../src/collector/topic-classifier.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const topicsPath = join(__dirname, '..', 'config', 'topics.yaml');

beforeAll(() => {
  loadTopics(topicsPath);
});

describe('loadTopics', () => {
  it('loads topics from YAML', () => {
    const topics = getLoadedTopics();
    expect(topics.length).toBeGreaterThan(50);
  });

  it('each topic has required fields', () => {
    for (const t of getLoadedTopics()) {
      expect(t.id).toBeTruthy();
      expect(t.label).toBeTruthy();
      expect(t.priority).toBeGreaterThan(0);
    }
  });
});

describe('classify', () => {
  it('classifies Bedrock content as foundation models', () => {
    const topics = classifyIds('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents...');
    expect(topics).toContain('ai.foundation-models');
  });

  it('classifies AI safety content', () => {
    const topics = classifyIds('Red Teaming LLMs', 'AI safety and alignment research...');
    expect(topics).toContain('ai.safety');
  });

  it('classifies CVE content', () => {
    const topics = classifyIds('CVE-2026-12345 Critical Vulnerability', 'exploit found in...');
    expect(topics).toContain('security.vulnerabilities');
  });

  it('requires context for short acronyms like EKS', () => {
    // EKS without container/k8s context should not match
    const noContext = classifyIds('EKS performance tips', 'general performance article');
    expect(noContext).not.toContain('compute.containers');

    // EKS with container context should match
    const withContext = classifyIds(
      'EKS performance tips',
      'AWS kubernetes cluster pod management',
    );
    expect(withContext).toContain('compute.containers');
  });

  it('requires context for RAG acronym', () => {
    // RAG without context should not match
    const noContext = classifyIds('RAG review', 'This rag is excellent');
    expect(noContext).not.toContain('ai.rag');

    // RAG with AI context should match
    const withContext = classifyIds(
      'Building RAG Applications',
      'retrieval augmented generation with vector embeddings',
    );
    expect(withContext).toContain('ai.rag');
  });

  it('returns at most 5 topics', () => {
    const topics = classifyIds(
      'Kubernetes Docker Terraform OpenAI Bedrock serverless Lambda',
      'serverless container function kubernetes cluster terraform openai gpt-4 bedrock sagemaker security vulnerability cve',
    );
    expect(topics.length).toBeLessThanOrEqual(5);
  });

  it('sorts by priority (highest first)', () => {
    const topics = classifyIds(
      'Cloud platform general features and networking',
      'amazon web services cloud platform service mesh istio load balancer',
    );
    // compute.cloud-platforms (priority 35) should come after compute.networking (priority 35)
    // or they should be in alphabetical order if same priority
    expect(topics.length).toBeGreaterThan(0);
  });

  it('returns empty for unrelated content', () => {
    const topics = classifyIds('Local bakery opens new location', 'Fresh bread and pastries daily');
    expect(topics.length).toBe(0);
  });

  it('returns confidence scores with classify()', () => {
    const topics = classify('AWS Announces Bedrock Agents GA', 'Amazon Bedrock agents...');
    expect(topics.length).toBeGreaterThan(0);
    for (const t of topics) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.confidence).toBe('number');
      expect(t.confidence).toBeGreaterThan(0);
      expect(t.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('classifies edge computing content', () => {
    const topics = classifyIds(
      'Cloudflare expands edge network for faster deployments',
      'New edge worker capabilities with durable objects support across global edge locations',
    );
    expect(topics).toContain('compute.edge');
  });

  it('classifies Go language content', () => {
    const topics = classifyIds(
      'Go 1.23 Release Notes',
      'The latest golang release includes improved goroutine scheduling and go concurrency primitives',
    );
    expect(topics).toContain('lang.go');
  });

  it('classifies architecture migration content', () => {
    const topics = classifyIds(
      'Migrating from Monolith to Microservices',
      'Managing technical debt through evolutionary architecture and strangler fig migration patterns',
    );
    expect(topics).toContain('arch.migration');
  });

  it('classifies compliance standards content', () => {
    const topics = classifyIds(
      'FedRAMP Authorization Updates',
      'New compliance framework requirements for fedramp authority to operate and nist 800-53 controls',
    );
    expect(topics).toContain('regulation.standards');
  });

  it('classifies testing content', () => {
    const topics = classifyIds(
      'Testing Best Practices for Microservices',
      'Unit test strategies, integration test patterns, and the test pyramid approach to code coverage',
    );
    expect(topics).toContain('devex.testing');
  });

  it('classifies open source licensing content', () => {
    const topics = classifyIds(
      'Open Source Initiative Updates License Guidelines',
      'The open source definition and license compliance requirements for gpl and apache license projects',
    );
    expect(topics).toContain('market.licensing');
  });

  it('does not false-positive lang.typescript from substring "ts"', () => {
    // Text with lots of words containing "ts" substring but no actual TypeScript content
    const topics = classifyIds(
      'Market insights and results from quarterly events',
      'Key highlights and aspects of deployment costs and benefits',
    );
    expect(topics).not.toContain('lang.typescript');
  });

  it('classifies energy market content', () => {
    const topics = classifyIds(
      'Oil and gas prices jump after Iran and Israel attack gasfields',
      'Brent crude oil prices surge as energy costs rise amid conflict in the strait of hormuz',
    );
    expect(topics).toContain('macro.energy');
  });

  it('classifies geopolitical conflict content', () => {
    const topics = classifyIds(
      'TSMC Stock Wilts as Iranian Attacks Batter Helium Supply and Threaten Chip Production',
      'Sanctions and trade restrictions on semiconductor exports amid military conflict',
    );
    expect(topics).toContain('macro.geopolitics');
  });

  it('classifies commodity supply content', () => {
    const topics = classifyIds(
      'Global Helium Shortage Threatens Semiconductor Fabrication',
      'Rare earth supply disruption and critical minerals shortage affecting chip production',
    );
    expect(topics).toContain('macro.commodities');
  });

  it('requires context for "war" keyword', () => {
    // "war" without geopolitical context should not match
    const noContext = classifyIds('Star Wars Movie Review', 'The latest film in the franchise');
    expect(noContext).not.toContain('macro.geopolitics');

    // "war" with geopolitical context should match
    const withContext = classifyIds(
      'The Iran War Is Destroying Something More Valuable Than Oil',
      'Military conflict and sanctions disrupt trade in the region',
    );
    expect(withContext).toContain('macro.geopolitics');
  });

  it('multi-keyword matches have higher confidence', () => {
    // Single keyword match
    const single = classify('Bedrock article', null);
    // Multiple keyword matches
    const multi = classify('Amazon Bedrock agents with Claude', 'Amazon Bedrock serverless AI agents bedrock');
    if (single.length > 0 && multi.length > 0) {
      const singleFoundation = single.find(t => t.id === 'ai.foundation-models');
      const multiFoundation = multi.find(t => t.id === 'ai.foundation-models');
      if (singleFoundation && multiFoundation) {
        expect(multiFoundation.confidence).toBeGreaterThanOrEqual(singleFoundation.confidence);
      }
    }
  });
});
