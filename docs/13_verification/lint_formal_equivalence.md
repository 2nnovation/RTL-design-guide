# Lint, Formal, and Equivalence

RTL 변경의 신뢰도는 “검증 tool이 통과했다”라는 한 문장으로 표현할 수 없다. 어떤 top과 configuration을 읽었는지, 무엇을 비교했는지, 어떤 초기 상태와 환경을 허용했는지에 따라 pass가 보장하는 범위가 달라진다. **도구 이름보다 검증한 질문과 그 질문의 전제를 먼저 읽어야 한다.**

이 문서는 RTL designer가 compile/elaboration, lint, simulation, formal property checking과 equivalence의 역할을 나누고, 실패를 수정 및 regression으로 연결하는 방법을 다룬다. Property sampling과 assumption/assertion/cover의 정의는 [Assertion-Driven RTL](assertion_driven_rtl.md), scenario와 coverage 관리는 [Corner-Case Matrix](corner_case_matrix.md)를 재사용한다. 예제와 반례 표는 교육용이며 실제 compiler·formal·equivalence 실행 결과가 아니다.

## 1. 각 검증이 답하는 질문

| 검증 | 주로 답하는 질문 | Pass만으로 보장하지 못하는 것 |
|---|---|---|
| Compile / elaboration | 문법, 연결, parameter/generate가 선택한 frontend에서 유효한가 | 기능, protocol, 전체 parameter 범위 |
| Lint | 선택한 규칙에서 의심스러운 RTL 구조가 있는가 | 명세상 올바른 priority와 알고리즘 |
| Simulation + checker | 실행한 stimulus와 상태 순서에서 기대 동작을 했는가 | 실행하지 않은 입력·history의 correctness |
| Formal property checking | 명시한 모델·가정에서 property 위반이 가능한가 | 쓰지 않은 requirement, 부정확한 환경 모델 |
| Combinational equivalence | 대응하는 입력/state cut에서 논리 함수가 같은가 | 임의의 다른 state encoding·latency의 순차 관계 |
| Sequential equivalence | 초기/state 관계와 clock 조건 아래 관측 trace가 대응하는가 | Reference 자체의 specification correctness |

실무 도구는 이 경계를 일부 결합한다. Lint가 제한적인 formal analysis를 쓰거나 equivalence가 조합 partition과 induction을 함께 사용할 수 있다. 여기의 구분은 제품 분류가 아니라 **증거의 의미**다.

예를 들어 clear와 set의 우선순위를 뒤집은 RTL은 문법적으로 완전하고 latch도 없을 수 있다. Lint rule만으로 어느 priority가 명세인지 알아낼 수 없다. Reference도 같은 priority 오류를 갖고 있으면 두 구현의 equivalence가 통과해도 요구사항 위반은 남는다.

## 2. 먼저 같은 설계를 읽었는지 확인한다

검증 전에 run의 identity를 고정한다.

- RTL, checker, harness, reference와 candidate의 revision.
- Top, filelist, include search path, define, parameter와 generate 결과.
- Tool/frontend/version, language mode와 적용한 rule/check 목록.
- Clock/reset 모델, initialization, 환경 assumption과 test/functional mode.
- Blackbox, memory/IP 모델, cutpoint, excluded output과 waiver.

같은 filename이라도 feature-off parameter로 elaborate하면 비교할 logic이 사라질 수 있다. Simulation과 synthesis의 define이 다르면 simulation pass가 구현 대상에 적용되지 않는다. Empty top이나 unresolved block을 허용한 run이 성공 종료했다고 해서 의도한 전체 block을 검사한 것은 아니다.

Run log의 elaborated hierarchy, port/instance 목록과 대상 property/partition 수를 함께 확인한다. 기대했던 output이나 assertion 수가 갑자기 줄어든 경우는 성능 개선보다 coverage 손실을 먼저 의심한다. Provenance의 공통 틀은 [Reading Synthesis Reports](../11_synthesis/read_synthesis_reports.md)를 참고한다.

## 3. Lint 결과를 수정할 때 보존할 의미

Lint는 compile이 받아들인 코드에서도 의심스러운 구조를 찾는 데 유용하다. 그러나 경고를 없애는 수정이 기능을 바꿀 수 있다.

| 발견 사항 | 확인할 hardware 의미 | 수정 시 다시 볼 contract |
|---|---|---|
| Width / signedness | 실제 operator 폭과 확장·절삭 | Carry, sign, saturation, compare 범위 |
| Incomplete assignment | Latch 또는 의도하지 않은 이전 값 의존 | Hold가 순차 state인지 누락된 combinational branch인지 |
| Multiple / missing driver | State owner, 연결과 미구동 bit | Arbitration, reset, inactive configuration |
| Unused / constant logic | Observer 누락 또는 합법적 제거 | Feature 선택, debug/test와 output 연결 |
| Case overlap / priority | 상호배타성 또는 명시한 우선순위 | 동시 입력, illegal encoding, default side effect |

예를 들어 폭 경고를 없애기 위해 결과를 cast하면 경고는 사라져도 필요한 carry가 잘릴 수 있다. 경고의 원인, 의도한 범위와 expected hardware를 확인한 뒤 수정한다. Verilator의 [Errors and Warnings](https://verilator.org/guide/latest/warnings.html#width)는 폭 관련 진단과 resize 방법을 설명하며, [경고 억제 설명](https://verilator.org/guide/latest/warnings.html#disabling-warnings)은 전역 억제가 검사 범위를 없앤다는 점을 지적한다.

Waiver는 정확한 rule·대상·configuration, 허용 근거, owner와 재검토 조건을 가진다. “기존에도 있었다” 또는 “third-party IP다”만으로 검토를 끝내지 않는다. 변경한 파일에 광범위한 suppression을 추가해 새로운 문제까지 가리지 않는지도 확인한다.

## 4. 예제: Set/Clear Rewrite의 비교 대상

[Assertion-Driven RTL](assertion_driven_rtl.md)의 sticky event bank를 사용한다. 계약은 `W >= 1`, same clock, active-high synchronous reset이며, bit별 priority는 `reset → set → clear → hold`다. 반복 event의 개수는 저장하지 않는다.

다음 module은 reference, **known 0/1 입력에서 계약을 보존하는 rewrite**, 의도적으로 priority를 잘못 바꾼 variant를 나란히 보여주는 비교용 wrapper다. 세 bank를 모두 제품에 넣으라는 구현 제안이 아니다.

```systemverilog
module event_rewrite_comparison #(
  parameter int unsigned W = 3
) (
  input  logic         clk,
  input  logic         rst,
  input  logic [W-1:0] event_mask,
  input  logic [W-1:0] clear_mask,
  output logic [W-1:0] q_ref,
  output logic [W-1:0] q_rewrite,
  output logic [W-1:0] q_wrong
);
  // Reference: reset > set > clear > hold.
  always_ff @(posedge clk) begin
    if (rst)
      q_ref <= '0;
    else
      q_ref <= (q_ref & ~clear_mask) | event_mask;
  end

  // Same priority, written as explicit per-bit decisions.
  always_ff @(posedge clk) begin
    if (rst) begin
      q_rewrite <= '0;
    end else begin
      for (int b = 0; b < W; b++) begin
        if (event_mask[b])
          q_rewrite[b] <= 1'b1;
        else if (clear_mask[b])
          q_rewrite[b] <= 1'b0;
      end
    end
  end

  // Intentionally wrong: clear now wins over a new event.
  always_ff @(posedge clk) begin
    if (rst) begin
      q_wrong <= '0;
    end else begin
      for (int b = 0; b < W; b++) begin
        if (clear_mask[b])
          q_wrong[b] <= 1'b0;
        else if (event_mask[b])
          q_wrong[b] <= 1'b1;
      end
    end
  end
endmodule
```

각 bank는 자기 state를 feedback한다. 비교 초기점에서 `q_ref == q_rewrite`이고 입력이 known이라면, bit별 네 priority partition이 같은 next state를 만들므로 다음 edge에도 equality가 유지된다. 공통 reset은 이 초기 equality를 만드는 한 방법이다.

초기 FF를 서로 독립적인 임의 값으로 놓고 첫 sample부터 equality를 요구하면, 동일한 transition logic도 실패할 수 있다. 반대로 두 state를 항상 같다고 assume하면 증명하려는 결과를 가정에 넣는 오류가 된다. 초기 관계와 유지해야 할 관계를 구분한다.

## 5. 작은 반례가 Lint Clean의 한계를 보여준다

`W=3`에서 다음 sequence를 생각한다. 표는 같은 edge 직전의 입력과 그 edge의 NBA 이후 Q다.

| Edge | rst | Event | Clear | q_ref after NBA | q_rewrite after NBA | q_wrong after NBA |
|---|---:|---|---|---|---|---|
| E0 | 1 | 000 | 000 | 000 | 000 | 000 |
| E1 | 0 | 001 | 001 | 001 | 001 | 000 |
| E2 | 0 | 000 | 000 | 001 | 001 | 000 |
| E3 | 0 | 000 | 001 | 000 | 000 | 000 |

E1에서 새 사건과 clear가 겹치면 wrong variant만 사건을 잃는다. E3에서 값이 다시 같아져도 E1–E2의 외부 관측 차이는 사라지지 않는다. 최종 state 한 번만 비교하는 test는 이런 transient mismatch를 놓칠 수 있다.

다음은 comparison wrapper 안에 추가할 수 있는 **verification-only partial checker**다. `reset_seen` 초기값은 harness의 history이며 DUT FF의 power-on 보장이 아니다.

```systemverilog
logic reset_seen = 1'b0;
always_ff @(posedge clk) begin
  if (rst)
    reset_seen <= 1'b1;
end

ap_same_after_reset: assert property (@(posedge clk)
  reset_seen |-> q_ref == q_rewrite);

cp_collision: cover property (@(posedge clk)
  reset_seen && !rst && (|(event_mask & clear_mask)));
```

E0의 reset NBA 이후 equality가 확립되고 E1 sample부터 비교한다. 만약 비교 대상을 `q_wrong`으로 바꾼 검증 전용 variant를 만든다면 E1 NBA에서 생긴 차이는 E2 sample의 assertion에서 드러난다. E1에서 바로 mismatch를 sample한다고 해석하지 않는다.

위 checker에는 clock 생성, reset sequence, input knownness/환경 모델과 종료 조건이 포함되어 있지 않다. Simulation과 formal에서 각각 그 harness를 준비하고, property가 실제로 활성화되고 collision에 도달하는지 확인한다. 논리식의 truth-table 검산은 이 SVA가 frontend에서 compile·실행됐다는 evidence가 아니다.

## 6. Two-State Equality와 X Semantics

앞의 rewrite가 계약을 보존한다는 주장은 known input과 대응하는 known state의 범위다. 일반적인 four-state RTL simulation의 X 전파까지 같다는 뜻은 아니다.

한 bit에서 `rst=0`, old Q=0, `event=X`, `clear=1`이면 reference 식은 `(0 & ~1) | X = X`다. 일반적인 procedural `if (event)`는 X를 true로 취급하지 않아 다음 clear branch를 선택하고 rewrite 결과는 0이 된다. 이 차이는 unknown control을 legal functional input으로 허용하자는 뜻이 아니라, **two-state 결과와 X 검사의 결론을 분리해야 한다는 예**다. Simulator의 별도 X-propagation mode를 쓰면 그 mode의 branch semantics도 확인한다.

Unknown이나 uninitialized state가 있는 equivalence flow에서는 다음 질문이 필요하다.

- X를 four-state 값, don't-care, nondeterministic 0/1 중 무엇으로 해석하는가.
- Reference와 candidate 양쪽의 해석이 같은가, refinement 관계인가.
- Resetless payload를 언제부터 비교하며 valid가 모든 observer를 가리는가.
- 임의 초기 state의 대응 관계가 증명 대상인지 harness 전제인지.
- Illegal encoding이나 memory 초기값을 unconstrained로 두는 범위가 일치하는가.

YosysHQ의 [Equivalence and X-Propagation](https://yosyshq.readthedocs.io/projects/eqy/en/latest/xprop.html)은 EQY가 unknown/don't-care에 대해 방향성이 있는 safe-replacement 의미를 사용하고 gold/gate의 X 해석을 구분한다고 설명한다. 따라서 reference와 candidate의 순서를 바꿔도 같은 질문이라고 가정하지 않는다. 이 flow의 해석을 모든 equivalence tool의 보편 규칙으로 확대하지도 않는다.

X를 고정 0으로 바꾸거나 initial state를 일괄 reset 값으로 묶는 것은 분석 모델을 바꾸는 일이다. 실제 integration이 그 조건을 보장하는지 먼저 확인한다. Resetless observer 조건은 [Resetless Datapath](../07_reset/resetless_datapath.md)를 참고한다.

## 7. Formal Property 결과의 범위를 읽는다

Formal은 주어진 모델에서 property를 검사한다. Tool이 모든 입력을 탐색한다고 해도 assumption으로 제외한 입력, 추상화한 block 내부, 모델에 없는 clock/reset 동작은 그 결론에 포함되지 않는다.

| 결과 | 해석 | 다음 판단 |
|---|---|---|
| Bounded safety pass | 지정한 초기 조건과 깊이 안에서 반례를 찾지 못함 | Requirement의 시간 범위와 충분성 확인 |
| Unbounded proof | 모델·가정 아래 property를 증명함 | 모델 정확성, coverage와 누락 requirement 검토 |
| Reachable counterexample | 허용한 실행이 property를 위반함 | 입력·history·specification·checker·DUT 분류 |
| Induction step 미완료 | 귀납 가정만으로 유지 성질을 입증하지 못함 | 도달 불가능 상태, 보조 invariant와 분할 검토 |
| Timeout / unknown / error | 결론이 없거나 실행 자체에 문제가 있음 | 원인 및 남은 검증 항목 기록 |

Bounded pass는 별도로 입증한 completeness bound가 없는 한 unbounded proof와 같지 않다. Induction-only trace 역시 초기 상태에서 실제로 도달하는 counterexample인지 확인해야 한다. 곧바로 DUT bug 또는 false alarm이라고 결정하지 않는다.

SBY의 [Options reference](https://symbiyosys.readthedocs.io/en/latest/reference.html#options-section)는 bounded safety, unbounded safety, liveness와 cover mode를 구분하며, depth의 의미도 mode/engine에 따라 다르다고 설명한다. 실행 report에는 mode와 engine, depth 및 결과를 함께 남긴다. Wrapper의 expected-failure 설정 때문에 shell 종료 코드가 성공이어도 property 자체는 실패일 수 있으므로 status를 직접 읽는다.

Vacuity와 over-constraint의 상세 점검은 [Assertion-Driven RTL](assertion_driven_rtl.md)에 따른다. 이번 예제에서 set/clear collision을 금지하면 wrong variant가 통과할 수 있다. 이 exclusion은 실제 명세와 모순되므로 합법적인 proof 단순화가 아니다.

## 8. Equivalence의 Compare Boundary를 검토한다

```text
                   shared legal inputs
                    /              \
             reference           candidate
             state R             state C
                    \              /
                 compare mapped observers

Initial/state relation + clock/reset + assumptions
                define the comparison question
```

조합 비교는 대응하는 FF output을 공통 cut input으로 보고 next-state/output 함수를 비교할 수 있다. 위 sticky bank처럼 state mapping이 직접적이면 유용하다. State encoding이나 register placement가 바뀌면 단순 bit-to-bit mapping이 실제 관계를 나타내지 않을 수 있다.

순차 비교는 cycle에 걸친 state 관계를 다루지만, 모든 tool/flow가 임의 retiming이나 latency 변경을 자동으로 허용하는 것은 아니다. Pipeline을 하나 추가해 output cycle이 달라졌다면 기존 cycle equality와 다른 계약이다. 승인된 latency 관계, valid alignment와 consumer 변경을 먼저 정의한다.

Blackbox와 partition에는 다음 책임이 따른다.

- 두 구현의 blackbox 모델이 같은 기능·latency·reset·memory collision 의미를 가지는지 확인한다.
- 공통 blackbox output을 묶어 비교하면 그 block 내부는 별도 검증 책임으로 남는다.
- Cutpoint를 독립 input으로 풀면 실제 state correlation이 사라져 가짜 반례가 생길 수 있다.
- Cutpoint equality나 invariant를 가정에 추가하면 그 관계를 다른 partition 또는 상위 증거로 보장해야 한다.
- Unmatched register/output, excluded partition과 failed/unknown partition이 있는지 확인한다.

특정 partition의 pass를 전체 설계 pass로 요약하지 않는다. EQY의 [Output Directory Format](https://yosyshq.readthedocs.io/projects/eqy/en/latest/outdir.html)은 matched names, partition 목록과 strategy별 status를 구분해 제공한다. 어떤 도구를 쓰든 대응 관계와 미완료 범위를 검토할 수 있는 artifact를 보관한다.

## 9. Counterexample을 Regression으로 바꾼다

반례를 받으면 전체 waveform보다 처음 의미가 갈라지는 edge를 찾는다.

1. Reference/candidate와 harness가 의도한 revision/configuration인지 확인한다.
2. Raw request가 아니라 acceptance, old state, sampled control과 NBA 결과를 정렬한다.
3. 초기/reset/X/blackbox 차이인지 실제 functional divergence인지 분류한다.
4. 명세상 합법적인 trace인지 확인하고 모호하면 specification gap으로 남긴다.
5. DUT 또는 checker/model의 원인을 수정하고 작은 directed case와 property로 재현한다.
6. 해당 parameter/mode 및 연관된 최적화 regression을 다시 실행한다.

환경이 불법이라는 판단으로 assumption을 추가하려면 producer/integration의 보장 evidence가 있어야 한다. Assertion을 완화해 반례만 없애거나, 실제 지원 mode를 제외해서 통과시키지 않는다.

Sticky bank의 첫 반례는 같은 bit의 set/clear collision이다. 이를 [Corner-Case Matrix](corner_case_matrix.md)의 pending/empty collision 두 행과 연결하면 old Q=1에서만 시험하고 old Q=0을 놓치는 실수를 줄일 수 있다.

## 10. Synthesis와 Timing, Power, Area Trade-off

Reference의 bitwise 식과 per-bit priority rewrite는 known 기능이 같으며 synthesis가 같은 논리로 정리할 수도 있다. 다른 generic structure를 거쳐 다른 cell mapping에 도달할 수도 있으므로 RTL 줄 수나 loop 유무만으로 빠르거나 작다고 판단하지 않는다.

| 변경 목적 | 먼저 보존할 기능 | 추가 비용 또는 evidence |
|---|---|---|
| Hold/enable inference 개선 | Set/clear/reset priority | Feedback MUX/CE, control timing, activity |
| State/bit 제거 | Observer와 reachable behavior | Decode 증가, invalid state와 X 정책 |
| 공유·복제 | Acceptance, ordering, 동시 요청 | MUX/fanout, clock/reset load, locality |
| Retiming/pipeline | 합의한 latency와 state correspondence | Setup/hold, FF area, clock power와 II |

Equivalence는 power나 timing이 개선됐다는 증거가 아니다. 조건부 output masking을 검증했어도 switching glitch나 physical route는 별도 분석 대상이다. 기능이 보존된 후보에 대해 같은 library, constraint, implementation stage와 workload로 PPA를 비교한다.

Verification wrapper의 세 bank와 history FF는 비교용 모델이다. 실제 implementation filelist에 포함한 단일 후보의 비용과 혼동하지 않는다. 합성 구조의 판단은 [Enable and MUX Inference](../11_synthesis/enable_and_mux_inference.md), 이후 측정은 [RTL to Post-Route Feedback](../12_physical_aware/rtl_to_post_route_feedback.md)로 연결한다.

## 11. Review Evidence와 종료 조건

결과표에는 최소한 다음을 남긴다.

| 항목 | 필요한 기록 |
|---|---|
| Target | Reference/candidate/checker/harness revision, top과 configuration |
| Question | Property 또는 compare point, cycle/state 관계 |
| Model | Initial/reset/X, clock, assumption, blackbox와 abstraction |
| Coverage | 실행한 test, reachable antecedent, 전체 partition 대비 완료 범위 |
| Result | Lint 진단, simulation 결과, bounded/proven/failed/unknown status |
| Follow-up | 미검증 항목, waiver 근거, owner와 변경 시 재실행 조건 |

- [ ] Lint clean을 functional correctness로 해석하지 않는가.
- [ ] 지원 parameter/define과 실제 elaborated hierarchy를 확인했는가.
- [ ] 초기 state 관계와 reset 이후 비교 시작점이 명시되어 있는가.
- [ ] Two-state equality와 X propagation/refinement의 의미를 구분했는가.
- [ ] Bounded pass, induction 미완료와 실제 reachable 반례를 구분하는가.
- [ ] Blackbox/cutpoint/waiver가 제외하는 기능에 별도 검증 책임이 있는가.
- [ ] 모든 필요한 property와 partition이 완료됐는가.
- [ ] Reference 자체를 requirement·assertion·test로 검토했는가.
- [ ] 반례를 재현 가능한 regression으로 남기고 변경 후 재실행하는가.
- [ ] 식 모델 검산, HDL 실행, formal proof와 PPA 결과를 구분해 보고하는가.

## 관련 문서

- [Assertion-Driven RTL](assertion_driven_rtl.md)
- [Corner-Case Matrix](corner_case_matrix.md)
- [Reset and Mode Transition Verification](reset_mode_transition_verification.md)
- [Datapath Width and Signedness](../10_datapath/width_signedness.md)
- [Microarchitecture Decision Record](../02_architecture/microarchitecture_decision_record.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
