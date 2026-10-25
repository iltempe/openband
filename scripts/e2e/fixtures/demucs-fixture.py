# A stand-in for htdemucs with the same inputs and outputs: mix (1, 2, n) -> stems (1, 4, 2, n),
# each stem a fixed share of the mix (drums 0.1, bass 0.2, other 0.3, vocals 0.4), so they sum to it.
import sys, onnx
from onnx import helper, TensorProto
shares = helper.make_tensor('shares', TensorProto.FLOAT, [1, 4, 1, 1], [0.1, 0.2, 0.3, 0.4])
axes = helper.make_tensor('axes', TensorProto.INT64, [1], [1])
g = helper.make_graph(
    [helper.make_node('Unsqueeze', ['mix', 'axes'], ['m4']), helper.make_node('Mul', ['m4', 'shares'], ['stems'])],
    'demucs-fixture',
    [helper.make_tensor_value_info('mix', TensorProto.FLOAT, [1, 2, 'n'])],
    [helper.make_tensor_value_info('stems', TensorProto.FLOAT, [1, 4, 2, 'n'])],
    [shares, axes])
m = helper.make_model(g, opset_imports=[helper.make_opsetid('', 17)], producer_name='openband-test')
m.ir_version = 8
onnx.checker.check_model(m)
onnx.save(m, sys.argv[1])
