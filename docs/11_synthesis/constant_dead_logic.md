# Constant and Dead Logic

예상보다 많은 register가 사라졌다는 report는 좋은 소식일 수도, wrong top이나 missing connection의 첫 증거일 수도 있다. Constant propagation과 dead-logic removal을 해석하려면 **어떤 입력 조건에서, 어떤 observer를 기준으로, 어느 단계가 제거했는지** 알아야 한다.

기능적으로 무엇이 불필요한지를 증명하는 정본은 [Unused Logic and State Reduction](../05_area/unused_logic_and_state_reduction.md)이다. 이 문서는 그 증명이 elaboration, synthesis input과 netlist evidence에 어떻게 연결되는지 다룬다. Numeric range와 truncation 자체의 정책은 [Datapath Width and Signedness](../10_datapath/width_signedness.md)를 따른다.

## 1. 다섯 종류의 “Constant”를 구분한다

| 근거 | 무엇이 고정되는가? | Synthesis netlist 제거에 대한 판단 |
|---|---|---|
| Elaboration parameter / generate | 해당 build에서 선택된 구조 | 비선택 generate branch는 elaborated design에 존재하지 않음; 선택 branch도 추가 최적화 가능 |
| 실제 RTL tie-off | 연결된 signal의 hardware value | Tie가 합성 입력에서 보이고 boundary를 전파할 수 있으면 consumer cone 단순화 가능 |
| Runtime stable configuration | 특정 interval 동안의 register/input 값 | 이후 legal write/mode가 있으면 일반적으로 constant가 아님; invariant와 flow 지원을 별도 확인 |
| STA case-analysis constraint | 분석 mode에서 가정한 signal value | STA 전용이면 timing model만 바뀜; synthesis가 이를 읽고 최적화에 사용하는지는 flow에 달림 |
| Formal assumption | Proof에서 허용하는 environment/state trace | 검증 범위를 제한함; 일반 synthesis가 자동으로 같은 assumption을 구현하거나 사용하지 않음 |

“System이 지금 이 mode로만 실행된다”는 관찰은 elaboration constant가 아니다. Stable configuration도 0과 1 양쪽 값이 각각 legal하다면 두 기능을 지원해야 한다. Boot 후 고정되는 mode라도 boot 전, 재설정, debug와 test 동작까지 계약에 포함한다.

```text
parameter choice ----------> elaborated structure
real RTL tie --------------> visible constants --> optimized netlist
runtime config ------------> legal values and transitions remain

STA mode assumption -------> timing analysis view
formal assumption ---------> proof environment
         |
         +--> netlist specialization only if an explicit, reviewed flow uses it
```

Constraint가 netlist에 영향을 주는 flow라면 assumption은 단순 분석 편의가 아니라 build contract다. 어떤 mode 전용 netlist인지, 다른 mode에 그 netlist를 사용하지 않도록 무엇이 막는지 기록해야 한다.

## 2. Elaboration-Time Feature Branch 예제

다음은 선택적으로 parity를 계산하는 one-stage stream이다. 지원 범위는 `W >= 1`, `FEATURE_PARITY`는 elaboration-time bit parameter다. Feature를 꺼도 port width를 0으로 만들지 않는다. `feature_present`는 기능 존재 여부를 알리는 constant output이다.

Feature-on에서는 reset release 후 `in_valid=1`인 edge마다 입력을 accept한다. Feature-off에서는 입력을 accept하지 않고 `out_valid=0`, `out_parity=0`을 항상 제공한다. Integrator는 `feature_present=0`인 instance로 응답이 필요한 transaction을 보내지 않아야 한다. 이것은 silent fallback parity 연산이 아니다.

```systemverilog
module optional_parity_stage #(
  parameter int unsigned W = 8,
  parameter bit FEATURE_PARITY = 1'b1
) (
  input  logic         clk,
  input  logic         rst_n,
  input  logic         in_valid,
  input  logic [W-1:0] in_data,
  output logic         feature_present,
  output logic         out_valid,
  output logic         out_parity
);
  assign feature_present = FEATURE_PARITY;

  generate
    if (FEATURE_PARITY) begin : g_enabled
      // Priority: asynchronous reset > valid advance and payload capture/hold.
      always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
          out_valid  <= 1'b0;
          out_parity <= 1'b0;
        end else begin
          out_valid <= in_valid;
          if (in_valid)
            out_parity <= ^in_data;
        end
      end
    end else begin : g_disabled
      assign out_valid  = 1'b0;
      assign out_parity = 1'b0;
    end
  endgenerate
endmodule
```

각 output은 선택된 generate branch 안에서 단일 driver를 갖는다. `W=1`에서 reduction XOR는 입력 bit 자체이며 port는 여전히 1 bit다. `W=0`은 지원하지 않고 build validation에서 거부한다. Feature-off를 표현하려고 `[FEATURE_PARITY*W-1:0]` 같은 range를 쓰지 않는다. 음수 index가 포함된 range가 빈 vector가 되는 것으로 기대할 수 없다.

### Cycle와 관찰 계약

아래는 W=4인 직접 만든 기능 예시이며 구현 측정값이 아니다. Reset assertion은 비동기이고 release는 해당 clock에 대해 안전하다고 가정한다. Feature-on consumer는 `out_valid=1`인 sample에서만 parity를 사용한다.

| Edge / 조건 | Feature-on: edge에서 관찰 | Feature-on: NBA 이후 | Feature-off: 항상 |
|---|---|---|---|
| Reset asserted | Invalid | valid=0, parity=0 | present=0, valid=0, parity=0 |
| E0, valid=1, data=0001 | Invalid | valid=1, parity=1 | 입력 무시, constant outputs |
| E1, valid=1, data=0011 | 이전 parity=1 소비 | valid=1, parity=0 | 입력 무시, constant outputs |
| E2, valid=0 | 이전 parity=0 소비 | valid=0, parity=0 유지 | 입력 무시, constant outputs |
| E3, valid=1, data=1110 | Invalid | valid=1, parity=1 | 입력 무시, constant outputs |
| E4, valid=0 | 이전 parity=1 소비 | valid=0, parity=1 유지 | 입력 무시, constant outputs |

Feature-on의 결과는 acceptance edge NBA에서 publish되고 다음 edge에 소비된다. II=1인 one-stage 구조다. Feature-off에는 parity register나 XOR cone이 필요하지 않지만 output 연결, tie cell이나 boundary resource가 남을 수 있다. “기능 cone 제거”와 “물리 cell 총수 0”을 동일시하지 않는다.

## 3. Report에서 Expected Removal을 찾는다

위 예제에 대해 build별로 다음 가설을 세울 수 있다. 이는 실행 결과가 아니라 확인해야 할 항목이다.

| Build | Elaboration에서 기대 | Mapping에서 확인할 것 | 제거가 이상한 경우 |
|---|---|---|---|
| Feature=0, W>=1 | Disabled branch만 존재 | Valid/parity constants, 불필요한 input cone 없음 | Output이 undriven이거나 feature-present가 1 |
| Feature=1, W=1 | Enabled branch와 legal 1-bit input | Reduction의 단순화, state/control 유지 | Reset 후 transaction 응답까지 constant |
| Feature=1, W>1 | Reduction와 registered output | XOR 기능, payload hold와 valid advance | Output이 쓰이는데 entire stage 제거 |
| Feature=1, wrapper output 미연결 | 내부 기능은 elaboration됨 | Boundary optimization에 따라 cone 제거 가능 | 필요한 interface를 실수로 연결하지 않음 |

Feature-on과 feature-off의 raw PPA 차이는 같은 기능의 최적화 효과가 아니다. 서로 다른 build 기능이다. 동일 기능 A/B 비교는 같은 parameter, interface와 observation contract를 고정해야 한다.

## 4. Tie-Off가 보이는 경계와 보이지 않는 경계

실제 wrapper에서 mode input을 constant 0에 연결하면 integration synthesis가 이를 전파할 수 있다. 그러나 child를 standalone top으로 합성하면 mode input은 동적으로 바뀔 수 있는 port다. 이미 별도로 mapping한 black box나 보존된 hierarchy가 있으면 바깥 tie가 안쪽까지 최적화되는지도 flow에 달려 있다.

```text
standalone block:
  mode input --> select --> both feature cones may remain

integrated wrapper:
  constant 0 --> select --> inactive cone may disappear
                            if the optimization boundary is open
```

따라서 standalone area와 integrated area를 비교할 때는 port loads뿐 아니라 input constants와 observation boundary도 기록한다. Logic이 남았다는 이유만으로 tool defect라고 결론 내리기 전에 실제 elaborated connection, preservation과 compile boundary를 확인한다.

## 5. Unused Status Register를 지워도 되는가

Functional output을 만들지 않는 status register라도 debug readback, test sequence, interrupt, reset 완료 또는 future legal mode가 observer일 수 있다. 반대로 verification-only monitor가 읽는다는 이유만으로 shipping hardware가 반드시 필요한 것은 아니다. Observer의 역할을 먼저 구분한다.

| Observer 후보 | 삭제 전 질문 | 필요한 증거 |
|---|---|---|
| 정상 datapath/protocol | Ready, valid, retry, ordering에 간접 영향이 있는가? | Next-state/output cone과 protocol tests |
| Debug/readback | Architecturally visible인가, 실험용 계측인가? | Debug interface 계약, required register map |
| Scan/test | DFT가 이 state의 제어/관찰을 요구하는가? | DFT owner와 mode별 검토 |
| Reset/init | Reset completion이나 retained state를 나타내는가? | Reset/power sequencing contract |
| 다른 legal mode | 현재 workload 외의 mode에서 읽는가? | Supported build/mode matrix |
| Verification instrumentation | Assertion용 shadow state인가? | Hardware requirement와 proof model의 분리 |

여기서 future legal mode는 이미 지원 계약에 포함된 mode다. 아직 명세에 없는 막연한 미래 확장을 이유로 모든 dead state를 남길 필요는 없지만, 지원 중인 mode를 workload에서 보지 못했다는 이유로 제거해서도 안 된다. State ownership와 reachability 판단은 [Unused Logic and State Reduction](../05_area/unused_logic_and_state_reduction.md)을 따른다.

## 6. Dead Result Bit와 필요한 Carry는 다르다

Output의 일부 bit만 사용하면 tool이 나머지 result bit와 그 전용 cone을 제거할 수 있다. 하지만 result bit 하나를 버린다고 그 bit에 기여한 모든 intermediate logic이 불필요해지는 것은 아니다.

다음은 module 내부에 두는 짧은 hypothesis fragment다. `W >= 1`이고 arithmetic normalization은 정본의 규칙을 따른다.

```systemverilog
logic [W-1:0] a, b, result_low;
logic [W:0] full_sum;
logic carry_out;

assign full_sum  = {1'b0, a} + {1'b0, b};
assign result_low = full_sum[W-1:0];
assign carry_out = full_sum[W];
```

`carry_out`이 정말 모든 observer에서 불필요하면 상위 결과만을 위한 logic이 제거될 수 있다. 그러나 carry가 overflow/status, saturation 선택 또는 exception을 만든다면 여전히 live다. Lower bits만 필요한 unsigned modulo addition과 전체 carry가 필요한 addition은 다른 계약이다.

반대로 상위 result bit만 남길 때 lower-bit 계산에서 발생하는 carry가 상위 bit를 결정할 수 있다. “출력 lower bits 미사용 → 모든 lower arithmetic 제거”도 안전한 일반화가 아니다. Multiply, rounding sticky bit와 compare 역시 dependency를 따라야 한다. [Overflow, Saturation, and Rounding](../10_datapath/overflow_saturation_rounding.md)과 [Bit-Width Minimization](../05_area/bit_width_minimization.md)을 참고한다.

## 7. Reset 값과 Runtime Stability의 함정

Reset에서 0을 쓰는 register가 항상 0인 것은 아니다. Legal input이나 mode change로 1이 될 수 있다면 constant propagation의 근거가 없다. `initial`에서 한 번 값을 준 사실도 모든 target의 power-on behavior나 이후 state invariant를 보장하지 않는다.

다음을 분리해 증명한다.

1. Allowed initial state는 무엇인가? Reset 전 값도 observer가 볼 수 있는가?
2. Reset은 반드시 실행되는가? 부분 reset, clock stop이나 warm reset은 어떤가?
3. 모든 legal transition에서 같은 값이 유지되는가?
4. Functional mode 외에 scan/debug/test가 state를 바꿀 수 있는가?
5. 그 invariant가 synthesis/equivalence flow에 실제로 전달되는가?

일부 tool은 initialization/reset semantics와 constant D/control을 이용해 sequential object를 단순화할 수 있다. 그러나 사용 중인 flow가 인정하는 시작 상태와 proof boundary를 확인해야 한다. Initialization assumption이 다른 두 netlist를 “reset 뒤에는 같아 보인다”는 simulation만으로 등가라고 결론 내리지 않는다.

Dynamic mode를 false path로 지정해도 hardware의 mode behavior가 제거되거나 안전해지지 않는다. False path는 해당 timing check를 제외하는 constraint다. 특정 static mode의 STA view를 만드는 것과 동적으로 사용할 경로의 timing을 숨기는 것은 다르다. Timing exception의 정본은 [Multi-Cycle Path](../03_timing/multi_cycle_path.md)를 따른다.

## 8. X는 Silicon의 안전한 Default가 아니다

`'x`는 simulation에서 unknown을 표현할 수 있고, synthesis에서는 don't-care 자유도로 이용될 수 있다. 따라서 “inactive branch에 X를 쓰면 저렴한 안전값이 나온다”는 주장은 성립하지 않는다. Physical output은 그 X 표기대로 떠 있는 안전 상태를 제공하는 것이 아니다.

- Legal no-match와 feature-off output은 예제처럼 deterministic default로 정의한다.
- Illegal input을 검출하려면 assertion/error policy를 사용한다. X assignment가 복구 회로를 대신하지 않는다.
- Unknown control에 대한 simulation optimism/pessimism과 two-state proof 가정을 구분한다.
- Don't-care 최적화가 필요하다면 해당 observation이 정말 금지되거나 mask되는 근거를 남긴다.
- Formal assumption이 illegal mode를 제외한다면 그 assumption의 실제 owner와 enforcement도 확인한다.

Deterministic default는 안전성과 검토 가능성을 높일 수 있지만 모든 illegal-state fault를 검출하지는 않는다. 또한 모든 상황에서 최소 area를 보장하지 않는다. 이 비용은 unspecified behavior를 몰래 늘리는 방식으로 줄이지 않는다.

## 9. Removal을 막는 것과 보존할 이유

| 경계 / 설정 | Logic이 남을 수 있는 이유 | Review 방향 |
|---|---|---|
| `keep` / `dont_touch`류 | Object 또는 cone의 삭제/변환을 제한 | 정확한 tool semantics, 적용 stage와 최소 scope 확인 |
| Debug preservation | 필요한 observation point 유지 | Required debug와 임시 계측을 구분 |
| Black box | 내부 기능을 볼 수 없음 | Model, interface와 tie propagation 한계 확인 |
| Hierarchy/partition | Separate compile 또는 boundary 최적화 제한 | Integrated run과 standalone run의 조건 차이 기록 |
| Test/scan mode | 기능 mode 외 state가 live | DFT 계약을 확인한 뒤 판단 |
| Unproven invariant | Runtime state가 constant라는 근거 부족 | 합성에 임의 assumption 추가 대신 계약과 proof 점검 |

Preservation을 전역 해제해 size를 줄이는 것이 기본 해법은 아니다. Debug, CDC와 특수 구조를 보호하는 이유가 있을 수 있다. 반대로 이름을 남기려는 목적만으로 큰 cone 전체를 보존하면 timing/power/area 최적화를 제한할 수 있다.

!!! note "확인한 tool-specific 사례"
    Yosys 0.56의 [Optimization passes](https://yosyshq.readthedocs.io/projects/yosys/en/v0.56/using_yosys/synthesis/opt.html)는 `opt_expr`의 constant folding, `opt_clean`의 unused cell/wire 제거, `opt_dff`의 sequential 최적화를 설명한다. 실제 제거 여부는 pass 입력과 state semantics에 달려 있으며, reset 값만으로 항상 constant라는 뜻이 아니다. 이 페이지는 해당 도구의 실행 결과를 제공하지 않는다.

## 10. Removed-Object Warning을 읽는 방법

```text
object removed
     |
     +--> expected feature-off / unused result? --> verify build and observer
     |
     +--> unexpected live function? -------------> trace backward
                                                    |
                         wrong top / missing port / constant enable
                         wrong parameter / unsupported or black-box model
```

제거된 객체마다 expected/needs-investigation을 나누고 근거를 남긴다. 다음 조합은 특히 의심한다.

- Enabled feature인데 output valid가 영구 0이다.
- Large datapath 전체가 사라지고 unresolved/undriven warning도 있다.
- State FF 수가 급감했는데 parameter/define 차이를 설명하지 못한다.
- Area뿐 아니라 timed endpoints도 함께 줄었다.
- Test/debug build에서 필요한 status가 constant가 됐다.

필요한 output에서 backward cone을 추적하고, 해당 enable와 mode가 어느 지점에서 constant가 되었는지 찾는다. Source에서 읽힌다는 사실보다 **현재 top과 mode에서 live observer에 연결됐는지**가 중요하다.

## 11. PPA 해석과 Controlled Comparison

Removal은 FF, operator, control MUX와 routing을 함께 없앨 수 있어 Disable보다 큰 이득이 될 수 있다. Clock/reset load가 줄면 physical implementation에도 영향을 준다. 그러나 제거 전후 숫자의 범위를 맞추지 않으면 절감량을 과장한다.

| 변화 | 가능한 이득 | 반드시 같이 볼 것 |
|---|---|---|
| Constant branch 제거 | Operator/MUX와 switching 감소 | 같은 feature/mode를 비교하는가? |
| Dead register 제거 | FF, clock/reset load 감소 | Debug/test/reset observer 손실 여부 |
| Dead-bit propagation | 연산·storage 폭 감소 | Carry/exception와 upper-bit dependency |
| Preservation 축소 | Mapping과 buffering 자유도 증가 | 보호하던 구조·constraint target 유지 |
| Hierarchy 밖까지 전파 | 더 큰 cone 제거 | Top-level connectivity와 compile contract |

작아진 netlist가 timing을 항상 개선하는 것도 아니다. Logic 재구성으로 짧은 hold path가 생기거나 공유된 남은 control에 load가 집중될 수 있다. 최종 판단은 [Reading Synthesis Reports](read_synthesis_reports.md)의 동일 조건 비교와 [Fanout and Locality](../12_physical_aware/fanout_and_locality.md)의 physical evidence를 따른다.

## 12. Build Matrix와 Sequential Equivalence

| 축 | 최소 검증 사례 | 확인하는 계약 |
|---|---|---|
| Feature parameter | On / off | 존재 여부와 deterministic disabled outputs |
| Width | 1 / 일반 값 / 최대 지원 값 | Legal elaboration과 bit dependency |
| Top boundary | Standalone / integrated wrapper | Tie-off와 live output 차이 |
| Runtime mode | 모든 지원 값과 legal transition | “Stable”을 “constant”로 오인하지 않음 |
| Initialization/reset | Cold / warm / partial reset, 해당되는 경우 | State 비교 시작점과 observer masking |
| Test/debug | Required modes | 보존돼야 할 상태와 연결 |

Feature=0과 Feature=1을 서로 equivalent라고 증명하는 것이 아니다. **각 build configuration을 고정한 원본과 optimized implementation**을 비교한다. Sequential equivalence는 allowed initial state, reset sequence, legal inputs, test/mode와 output observation contract를 공유해야 한다. 가정으로 모든 유효 transaction을 제외한 vacuous proof도 탐지한다.

예제의 enabled branch에 넣을 SVA fragment는 다음과 같다. Disabled build에는 별도 constant check를 둔다. E0 input의 parity가 E0 NBA에 저장되므로 E1 sample을 보는 `|=>`가 맞다.

```systemverilog
ap_parity_capture:
  assert property (@(posedge clk) disable iff (!rst_n)
    in_valid |=> out_valid && out_parity == ^$past(in_data));

ap_parity_bubble:
  assert property (@(posedge clk) disable iff (!rst_n)
    !in_valid |=> !out_valid && $stable(out_parity));
```

Feature-off에서는 reset과 무관하게 outputs가 constant인지 확인하고, integration test는 disabled instance에 응답을 기다리는 request를 보내지 않는지도 검사한다. Simulation reference, formal proof, compile/elaboration과 actual mapping check는 각각 수행 여부를 따로 보고한다.

## 13. Common Mistakes와 Design Review Checklist

흔한 실수는 reset value, workload의 안정된 mode, STA case analysis와 formal assumption을 모두 같은 constant 근거로 취급하는 것이다. 또 제거된 cell 수만 보고 기능 보존을 추정하거나, output bit를 버리면서 overflow/error observer를 놓치기 쉽다.

- [ ] Constant의 근거가 parameter, tie-off, runtime invariant, STA 또는 formal 중 무엇인가?
- [ ] 그 근거를 실제 synthesis flow가 읽고 사용하는가?
- [ ] Feature-off에서도 port width와 output/valid 계약이 legal한가?
- [ ] Required debug/test, reset, protocol과 모든 legal mode의 observer를 확인했는가?
- [ ] Dead-bit 제거가 carry/overflow/rounding/exception을 보존하는가?
- [ ] Initial/reset 값과 모든 legal transition의 invariant를 구분했는가?
- [ ] X를 silicon safe value나 암묵적 최적화 계약으로 쓰지 않는가?
- [ ] Preservation과 black-box/hierarchy boundary의 이유가 기록됐는가?
- [ ] Unexpected removal의 원인을 output부터 cross-probe했는가?
- [ ] Build matrix별 sequential equivalence와 initialization contract가 일치하는가?
- [ ] Area 감소가 기능·timing coverage 감소 때문이 아님을 확인했는가?

## 관련 문서

- [Unused Logic and State Reduction](../05_area/unused_logic_and_state_reduction.md)
- [RTL to Hardware Mapping](rtl_to_hardware_mapping.md)
- [Reading Synthesis Reports](read_synthesis_reports.md)
- [Resetless Datapath](../07_reset/resetless_datapath.md)
- [RTL Design Review Checklist](../15_checklist/rtl_design_review_checklist.md)
